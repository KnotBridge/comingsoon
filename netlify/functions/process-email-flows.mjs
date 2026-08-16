import { admin, json, substituteVars } from "../lib/shared.mjs";

const NODE_GUARD = 50;
const ADVANCE_LIMIT = 100;

const findNode = (nodes, id) => nodes.find((n) => n.id === id);
const triggerNode = (nodes) => nodes.find((n) => n.type === "trigger");

// Target of the edge leaving `from`. For condition nodes the taken branch is
// selected by sourceHandle ("yes"/"no"); falls back to any outgoing edge.
function follow(edges, from, branch) {
  if (branch) {
    const b = edges.find((e) => e.source === from && (e.sourceHandle === branch));
    if (b) return b.target;
  }
  const e = edges.find((x) => x.source === from);
  return e ? e.target : null;
}

// Advance due enrollments + auto-enroll audiences; also callable via HTTP with
// { action:"enroll", flow_id, contact_ids?/audience_id? } and { action:"tick" }.
export default async (req) => {
  const sb = admin();
  let body = {};
  if (req.method === "POST") body = await req.json().catch(() => ({}));

  // Health check used by the flow builder to confirm the engine is reachable.
  if (body.action === "ping") return json({ version: "1.0", ok: true });

  if (body.action === "enroll" && body.flow_id) {
    const auds = body.audience_ids || (body.audience_id ? [body.audience_id] : []);
    let n = 0;
    if (body.contact_ids?.length) n += await enroll(sb, body.flow_id, { contact_ids: body.contact_ids });
    for (const a of auds) n += await enroll(sb, body.flow_id, { audience_id: a });
    return json({ enrolled: n });
  }

  // Auto-enroll audiences for active flows whose trigger names an audience.
  const { data: flows } = await sb.from("email_flows").select("*").eq("is_active", true).eq("domain", "outreach");
  let enrolled = 0;
  for (const flow of flows || []) {
    const trig = triggerNode(flow.nodes_json || []);
    const cfg = { ...(flow.trigger_config || {}), ...(trig?.config || {}) };
    const audienceIds = cfg.audienceIds || (cfg.audienceId ? [cfg.audienceId] : []);
    for (const aud of audienceIds) enrolled += await enroll(sb, flow.id, { audience_id: aud });
  }

  // Advance due enrollments.
  const now = new Date().toISOString();
  const { data: due } = await sb.from("email_flow_enrollments")
    .select("*").eq("status", "active").lte("next_run_at", now)
    .order("next_run_at", { ascending: true }).limit(ADVANCE_LIMIT);

  // Claim this batch by pushing next_run_at forward, so an overlapping run (manual
  // Start + the every-minute cron) can't grab the same enrollments and double-queue.
  if (due?.length) {
    await sb.from("email_flow_enrollments")
      .update({ next_run_at: new Date(Date.now() + 120000).toISOString() })
      .in("id", due.map((e) => e.id)).eq("status", "active");
  }

  const flowCache = new Map();
  const getFlow = async (id) => {
    if (!flowCache.has(id)) {
      const { data } = await sb.from("email_flows").select("*").eq("id", id).maybeSingle();
      flowCache.set(id, data);
    }
    return flowCache.get(id);
  };

  let advanced = 0;
  for (const enr of due || []) {
    const flow = await getFlow(enr.flow_id);
    if (!flow) continue;
    try { await advanceOne(sb, enr, flow); advanced++; } catch (e) { console.error("advance", enr.id, e?.message); }
  }
  return json({ enrolled, advanced });
};

async function advanceOne(sb, enr, flow) {
  const nodes = flow.nodes_json || [];
  const edges = flow.edges_json || [];

  // Hard stop if the contact replied / unsubscribed.
  if (enr.contact_id) {
    const { data: c } = await sb.from("outreach_contacts").select("status").eq("id", enr.contact_id).maybeSingle();
    if (c && ["replied", "unsubscribed", "rejected"].includes(c.status)) {
      await sb.from("email_flow_enrollments").update({ status: "completed" }).eq("id", enr.id);
      return;
    }
  }

  let nodeId = enr.current_node_id;
  if (!nodeId) { const t = triggerNode(nodes); nodeId = t ? follow(edges, t.id) : null; }
  else { const cur = findNode(nodes, nodeId); if (cur?.type === "trigger") nodeId = follow(edges, nodeId); }

  let guard = 0, lastQueueId = enr.last_queue_item_id ?? null;
  while (nodeId && guard++ < NODE_GUARD) {
    const node = findNode(nodes, nodeId);
    if (!node) break;

    if (node.type === "email") {
      const senderId = await resolveFlowSender(sb, flow);
      const qid = await queueEmail(sb, enr, node, senderId);
      if (qid) lastQueueId = qid;
      const next = follow(edges, node.id);
      await sb.from("email_flow_enrollments").update({
        current_node_id: next, last_queue_item_id: lastQueueId,
        next_run_at: new Date(Date.now() + 30_000).toISOString(),
        status: next ? "active" : "completed",
      }).eq("id", enr.id);
      return; // one email per tick
    }

    if (node.type === "wait") {
      const amount = Number(node.config?.amount) || 1;
      const unit = node.config?.unit || "days";
      const ms = amount * (unit === "minutes" ? 60e3 : unit === "hours" ? 3600e3 : 86400e3);
      const next = follow(edges, node.id);
      await sb.from("email_flow_enrollments").update({
        current_node_id: next, last_queue_item_id: lastQueueId,
        next_run_at: new Date(Date.now() + ms).toISOString(),
        status: next ? "active" : "completed",
      }).eq("id", enr.id);
      return;
    }

    if (node.type === "condition") {
      const yes = await evalCondition(sb, enr, node, lastQueueId);
      nodeId = follow(edges, node.id, yes ? "yes" : "no") ?? follow(edges, node.id);
      continue;
    }

    if (node.type === "action") {
      await sb.from("email_flow_enrollments").update({ status: "completed", current_node_id: node.id }).eq("id", enr.id);
      return;
    }

    nodeId = follow(edges, node.id);
  }
  await sb.from("email_flow_enrollments").update({ status: "completed", current_node_id: null, last_queue_item_id: lastQueueId }).eq("id", enr.id);
}

async function evalCondition(sb, enr, node, lastQueueId) {
  const key = node.config?.conditionKey || "opened";
  if ((key === "opened" || key === "clicked") && lastQueueId) {
    const { data } = await sb.from("email_events").select("id")
      .eq("queue_item_id", lastQueueId).eq("event_type", key === "opened" ? "open" : "click").limit(1);
    return !!data?.length;
  }
  if (key === "replied" && enr.contact_id) {
    const { data } = await sb.from("outreach_contacts").select("status").eq("id", enr.contact_id).maybeSingle();
    return data?.status === "replied";
  }
  return false;
}

async function queueEmail(sb, enr, node, senderId) {
  // Idempotency guard: never queue the same flow node twice for the same contact.
  // This makes the engine safe against re-runs and stops any duplicate-send storm.
  if (enr.contact_id && node.id) {
    const { data: dup } = await sb.from("email_queue").select("id")
      .eq("flow_id", enr.flow_id).eq("flow_node_id", node.id)
      .eq("outreach_contact_id", enr.contact_id).limit(1).maybeSingle();
    if (dup) return dup.id;
  }
  let subject = node.config?.subject || "";
  let bodyHtml = node.config?.body_html || node.config?.bodyHtml || "";
  const templateId = node.config?.templateId;
  let trackOpens = true, includeUnsub = true;
  if (templateId) {
    const { data: tpl } = await sb.from("outreach_templates").select("*").eq("id", templateId).maybeSingle();
    if (tpl) {
      subject = tpl.subject; bodyHtml = tpl.body_html;
      trackOpens = tpl.track_opens !== false; includeUnsub = tpl.include_unsubscribe !== false;
    }
  }
  if (!subject && !bodyHtml) return null; // misconfigured node — nothing to send

  let contact = { email: enr.email, name: enr.email };
  if (enr.contact_id) {
    const { data } = await sb.from("outreach_contacts").select("*").eq("id", enr.contact_id).maybeSingle();
    if (data) contact = data;
  }
  const { data: row, error } = await sb.from("email_queue").insert({
    queue_type: "outreach", outreach_contact_id: enr.contact_id || null,
    flow_id: enr.flow_id, flow_node_id: node.id, sender_account_id: senderId,
    recipient_email: contact.email, recipient_name: contact.name,
    subject: substituteVars(subject, contact), html_body: substituteVars(bodyHtml, contact),
    track_opens: trackOpens, include_unsubscribe: includeUnsub, status: "pending",
  }).select("id").single();
  if (error) { console.error("queueEmail", error.message); return null; }

  // NOTE: Supabase query builders are thenable but have no .catch(), so never chain
  // .catch on them — it throws and would abort the advance. Just await; errors come
  // back in { error } and are non-fatal here.
  if (enr.contact_id) {
    await sb.from("outreach_contacts").update({ last_contacted_at: new Date().toISOString() }).eq("id", enr.contact_id);
  }
  return row.id;
}

async function resolveFlowSender(sb, flow) {
  if (flow.sender_account_id) return flow.sender_account_id;

  // Rotate across a group's active senders so volume spreads (not all on one
  // mailbox hitting its daily cap). Use the flow's group, else the default group.
  let groupId = flow.sender_group_id;
  if (!groupId) {
    const { data: g } = await sb.from("sender_groups").select("id").eq("is_default", true).limit(1).maybeSingle();
    groupId = g?.id || null;
  }
  if (groupId) {
    const { data: senders } = await sb.from("email_sender_accounts")
      .select("id").eq("group_id", groupId).eq("is_active", true).order("created_at");
    if (senders?.length) {
      const { data: grp } = await sb.from("sender_groups").select("rotation_cursor").eq("id", groupId).maybeSingle();
      const cursor = grp?.rotation_cursor ?? 0;
      await sb.from("sender_groups").update({ rotation_cursor: cursor + 1 }).eq("id", groupId);
      return senders[cursor % senders.length].id;
    }
  }

  // Last resort: rotate across ALL active senders using their own cursor counter.
  const { data: all } = await sb.from("email_sender_accounts")
    .select("id").eq("is_active", true).order("created_at");
  if (all?.length) return all[Math.floor(Math.random() * all.length)].id;
  return null;
}

async function enroll(sb, flowId, opts) {
  const { data: flow } = await sb.from("email_flows").select("id, ignore_contacted").eq("id", flowId).maybeSingle();
  if (!flow) return 0;
  let contacts = [];
  if (opts.contact_ids?.length) {
    ({ data: contacts } = await sb.from("outreach_contacts").select("id,email,status").in("id", opts.contact_ids));
  } else if (opts.audience_id) {
    ({ data: contacts } = await sb.from("outreach_contacts").select("id,email,status").eq("audience_id", opts.audience_id));
  }
  contacts = (contacts || []).filter((c) => c.email && !["unsubscribed", "rejected"].includes(c.status));
  if (!contacts.length) return 0;

  // Skip contacts already enrolled in this flow.
  const ids = contacts.map((c) => c.id);
  const { data: existing } = await sb.from("email_flow_enrollments")
    .select("contact_id").eq("flow_id", flowId).in("contact_id", ids);
  const have = new Set((existing || []).map((e) => e.contact_id));
  const fresh = contacts.filter((c) => !have.has(c.id));
  if (!fresh.length) return 0;

  const now = new Date().toISOString();
  const rows = fresh.map((c) => ({
    flow_id: flowId, domain: "outreach", subject_type: "contact",
    contact_id: c.id, email: c.email, status: "active", next_run_at: now,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    await sb.from("email_flow_enrollments").insert(rows.slice(i, i + 200));
  }
  return fresh.length;
}
