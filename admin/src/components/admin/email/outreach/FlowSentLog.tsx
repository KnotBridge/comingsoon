import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ChevronDown, ChevronRight, Eye, X, RefreshCw, MousePointerClick, MailOpen, Reply, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { countsAsOpen, countsAsClick, countsAsLoad, countsAsReply, countsAsBounce } from "../flows/metrics";
import { buildEmailPreviewSrcDoc } from "./emailPreview";

// Flow sent log. Flow emails all share one internal "Flows (internal tracking)"
// campaign, so the campaign-grouped Sent Log can't tell flows apart, can't tell
// which step (intro vs follow-up) an email is, and shows a meaningless lumped
// click rate. Flow + step attribution lives only in
// email_flow_enrollments.context.sentItems (node -> queue id), so we rebuild the
// log from there: real per-step rates, and per recipient the exact link clicked.
// Opens/clicks/loads/bounces are classified via the shared metrics rules so this
// view's numbers always match the Flows builder funnel and per-card stats.
//
// Every flow is listed at once with its own rates, mirroring how campaigns read in
// the Sent Log — no picker to hunt through, and flows are comparable side by side.
// Everything loads in one pass, so expanding a flow is instant.

interface FlowLite { id: string; name: string; nodes_json: { id: string; type: string; label?: string; config?: { subject?: string } }[]; is_active: boolean; created_at: string }
interface EnrRow { flow_id: string; contact_id: string | null; status: string; context: { sentItems?: { node: string; qid: string }[] } | null }
interface QRow { id: string; recipient_email: string; recipient_name: string | null; status: string; sent_at: string | null; subject: string | null; html_body: string | null; error_message: string | null; scheduled_for: string | null; attempts: number | null; email_format: string | null; tracking_image_url: string | null }
interface EvRow { queue_item_id: string; event_type: string; link_url: string | null; link_id: string | null; user_agent: string | null; created_at: string }

interface EmailRow {
  qid: string;
  flowId: string;
  node: string;
  recipient_email: string;
  recipient_name: string | null;
  status: string;
  sent_at: string | null;
  subject: string | null;
  html_body: string | null;
  email_format: string | null;
  tracking_image_url: string | null;
  opens: EvRow[];
  clicks: EvRow[];
  replies: EvRow[];
  bounces: EvRow[];
  replied: boolean;   // reply from email_events OR outreach_replies (see computeFlowRows)
  repliedAt: string | null;
  error: string | null;        // why it failed, straight from the send worker
  scheduledFor: string | null; // when it is due (future = waiting, e.g. held by a cap)
  attempts: number;
  loaded: boolean;
  loadedAt: string | null;
}

interface Totals { sent: number; failed: number; suppressed: number; waiting: number; opened: number; clicked: number; replied: number; bounced: number; loaded: number }
interface StepStat extends Totals { node: string; label: string; subject: string; order: number; total: number }

const ENR_PAGE = 1000;
const ENR_CAP = 8000;

function shortLink(url: string | null): string {
  if (!url) return "(link)";
  return url.replace(/^https?:\/\//, "").replace(/\?.*$/, "").slice(0, 48);
}
function timeOf(s: string | null) { return s ? new Date(s).toLocaleString() : "—"; }
function pct(n: number, d: number) { return d ? Math.round((n / d) * 100) + "%" : "—"; }
// Bounce is the one metric where a big number is bad, so it gets its own scale
// instead of the neutral tone the others use. Past 5% the SES account itself is at
// risk, which is why it goes red rather than just dark.
const bounceTone = (n: number, d: number) => {
  if (!d || n === 0) return "text-muted-foreground";
  const p = (n / d) * 100;
  return p >= 5 ? "text-red-600 font-semibold" : p >= 2 ? "text-amber-600 font-medium" : "text-muted-foreground";
};

function rollup(list: EmailRow[]): Totals {
  const now = Date.now();
  return {
    sent: list.filter((r) => r.status === "sent").length,
    failed: list.filter((r) => r.status === "failed").length,
    suppressed: list.filter((r) => r.status === "suppressed").length,
    // Queued but not due yet — usually a daily cap holding it for tomorrow, or the
    // flow's send-interval drip spacing it out.
    waiting: list.filter((r) => (r.status === "pending" || r.status === "sending")
      && !!r.scheduledFor && new Date(r.scheduledFor).getTime() > now).length,
    opened: list.filter((r) => r.opens.length > 0).length,
    clicked: list.filter((r) => r.clicks.length > 0).length,
    replied: list.filter((r) => r.replied).length,
    bounced: list.filter((r) => r.bounces.length > 0).length,
    loaded: list.filter((r) => r.loaded).length,
  };
}

// One metric cell: the number, then its rate in parentheses.
function Stat({ n, d, tone }: { n: number; d: number; tone: string }) {
  return (
    <td className="px-3 py-2.5 text-xs whitespace-nowrap">
      <span className={n > 0 ? tone : "text-muted-foreground"}>{n}</span>
      <span className="text-muted-foreground/70 ml-1">({pct(n, d)})</span>
    </td>
  );
}

// Load one flow's emails: its enrollments -> queued ids -> queue rows -> events. Scoped
// to a single flow so it stays cheap, and run lazily (in the background per row, on
// demand on expand) instead of walking every flow up front — that up-front pass was what
// made opening the tab hang. Mirrors how the campaigns view fills stats without blocking.
async function computeFlowRows(flow: FlowLite): Promise<{ rows: EmailRow[]; capped: boolean }> {
  const enrRows: EnrRow[] = [];
  for (let from = 0; from < ENR_CAP; from += ENR_PAGE) {
    const { data } = await supabase.from("email_flow_enrollments" as any)
      .select("flow_id,contact_id,status,context").eq("flow_id", flow.id)
      .order("entered_at", { ascending: false }).range(from, from + ENR_PAGE - 1);
    const chunk = (data as unknown as EnrRow[]) || [];
    enrRows.push(...chunk);
    if (chunk.length < ENR_PAGE) break;
  }
  const capped = enrRows.length >= ENR_CAP;

  const qidToNode = new Map<string, string>();
  for (const r of enrRows) {
    for (const it of r.context?.sentItems || []) {
      if (it.qid) qidToNode.set(it.qid, it.node);
    }
  }
  const qids = [...qidToNode.keys()];
  if (qids.length === 0) return { rows: [], capped };

  const qById = new Map<string, QRow>();
  for (let i = 0; i < qids.length; i += 200) {
    const { data: qq } = await supabase.from("email_queue")
      .select("id,recipient_email,recipient_name,status,sent_at,subject,html_body,error_message,scheduled_for,attempts,email_format,tracking_image_url").in("id", qids.slice(i, i + 200));
    for (const r of (qq as QRow[]) || []) qById.set(r.id, r);
  }
  const evByQid = new Map<string, EvRow[]>();
  for (let i = 0; i < qids.length; i += 200) {
    const { data: ev } = await supabase.from("email_events")
      .select("queue_item_id,event_type,link_url,link_id,user_agent,created_at").in("queue_item_id", qids.slice(i, i + 200));
    for (const e of (ev as EvRow[]) || []) {
      const arr = evByQid.get(e.queue_item_id) || []; arr.push(e); evByQid.set(e.queue_item_id, arr);
    }
  }
  // Replies also live in outreach_replies, which gets a row even when the email_events
  // 'reply' insert is skipped (e.g. campaign id missing, or it was an auto-reply). Read
  // both so a real reply to a flow email never goes missing from this log.
  const repliedAt = new Map<string, string>();
  for (let i = 0; i < qids.length; i += 200) {
    const { data: rr } = await supabase.from("outreach_replies")
      .select("queue_item_id,replied_at").eq("direction", "inbound").in("queue_item_id", qids.slice(i, i + 200));
    for (const r of (rr as { queue_item_id: string | null; replied_at: string | null }[]) || []) {
      if (r.queue_item_id && !repliedAt.has(r.queue_item_id)) repliedAt.set(r.queue_item_id, r.replied_at || "");
    }
  }

  const out: EmailRow[] = [];
  for (const qid of qids) {
    const q = qById.get(qid);
    if (!q) continue; // queue row gone
    const evs = evByQid.get(qid) || [];
    const pageViews = evs.filter(countsAsLoad);
    const eventReplies = evs.filter(countsAsReply);
    const replied = eventReplies.length > 0 || repliedAt.has(qid);
    out.push({
      qid, flowId: flow.id, node: qidToNode.get(qid) || "",
      recipient_email: q.recipient_email, recipient_name: q.recipient_name,
      status: q.status, sent_at: q.sent_at, subject: q.subject, html_body: q.html_body,
      email_format: q.email_format, tracking_image_url: q.tracking_image_url,
      error: q.error_message || null, scheduledFor: q.scheduled_for || null, attempts: q.attempts || 0,
      opens: evs.filter(countsAsOpen), clicks: evs.filter(countsAsClick),
      replies: eventReplies, bounces: evs.filter(countsAsBounce),
      replied, repliedAt: eventReplies[0]?.created_at || repliedAt.get(qid) || null,
      loaded: pageViews.length > 0, loadedAt: pageViews[0]?.created_at || null,
    });
  }
  return { rows: out, capped };
}

export default function FlowSentLog() {
  const [flows, setFlows] = useState<FlowLite[]>([]);
  // Per-flow email rows, filled in lazily. Missing key = not computed yet (show "…").
  const [rowsByFlow, setRowsByFlow] = useState<Record<string, EmailRow[]>>({});
  const [loading, setLoading] = useState(true);
  const [capped, setCapped] = useState(false);
  const [expandedFlow, setExpandedFlow] = useState<string | null>(null);
  const [stepFilter, setStepFilter] = useState<string>(""); // node id, "" = all
  const [search, setSearch] = useState("");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [preview, setPreview] = useState<EmailRow | null>(null);

  // Just the flow list + a cheap enrolled count per flow. Like the campaigns log, this is
  // all the tab loads up front — no walking every flow's emails. A flow's real stats and
  // per-recipient detail are loaded only when you expand it.
  const [enrolled, setEnrolled] = useState<Record<string, number>>({});
  const load = useCallback(async () => {
    setLoading(true);
    setRowsByFlow({});
    const { data: f } = await supabase.from("email_flows" as any)
      .select("id,name,nodes_json,is_active,created_at").eq("domain", "outreach")
      .order("created_at", { ascending: false });
    const list = (f as unknown as FlowLite[]) || [];
    setFlows(list);
    setLoading(false);
    // Enrolled counts are HEAD counts (the DB counts, nothing is transferred), so they're
    // cheap even for big flows and don't block the list.
    const counts: Record<string, number> = {};
    await Promise.all(list.map(async (fl) => {
      const { count } = await supabase.from("email_flow_enrollments" as any)
        .select("id", { count: "exact", head: true }).eq("flow_id", fl.id);
      counts[fl.id] = count || 0;
    }));
    setEnrolled(counts);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Compute one flow's rows once, on expand, caching the result.
  const inflight = useRef<Set<string>>(new Set());
  const ensureFlow = useCallback(async (flow: FlowLite) => {
    if (rowsByFlow[flow.id] || inflight.current.has(flow.id)) return;
    inflight.current.add(flow.id);
    try {
      const { rows, capped: c } = await computeFlowRows(flow);
      setRowsByFlow((prev) => ({ ...prev, [flow.id]: rows }));
      if (c) setCapped(true);
    } finally {
      inflight.current.delete(flow.id);
    }
  }, [rowsByFlow]);

  // Per-step rollup for the open flow. Order steps by earliest send so the journey
  // reads top-down.
  const steps = useMemo<StepStat[]>(() => {
    if (!expandedFlow) return [];
    const flow = flows.find((f) => f.id === expandedFlow);
    const list = rowsByFlow[expandedFlow] || [];
    const nodeLabel = new Map<string, { label: string; subject: string }>();
    for (const n of flow?.nodes_json || []) {
      if (n.type === "email") nodeLabel.set(n.id, { label: n.label || "Email", subject: n.config?.subject || "" });
    }
    const byNode = new Map<string, EmailRow[]>();
    for (const r of list) { const a = byNode.get(r.node) || []; a.push(r); byNode.set(r.node, a); }
    const out: StepStat[] = [];
    for (const [node, l] of byNode) {
      const earliest = l.reduce<number>((min, r) => { const t = r.sent_at ? new Date(r.sent_at).getTime() : Infinity; return Math.min(min, t); }, Infinity);
      const meta = nodeLabel.get(node) || { label: "Email", subject: "" };
      out.push({
        node, label: meta.label, subject: meta.subject || l.find((r) => r.subject)?.subject || "",
        order: earliest, total: l.length, ...rollup(l),
      });
    }
    out.sort((a, b) => a.order - b.order);
    return out;
  }, [expandedFlow, flows, rowsByFlow]);

  const stepOrder = useMemo(() => new Map(steps.map((s, i) => [s.node, i + 1])), [steps]);
  const stepLabelOf = useMemo(() => new Map(steps.map((s) => [s.node, s.label])), [steps]);

  const visibleRows = useMemo(() => {
    if (!expandedFlow) return [];
    let r = rowsByFlow[expandedFlow] || [];
    if (stepFilter) r = r.filter((x) => x.node === stepFilter);
    const q = search.trim().toLowerCase();
    if (q) r = r.filter((x) => x.recipient_email.toLowerCase().includes(q) || (x.recipient_name || "").toLowerCase().includes(q));
    return [...r].sort((a, b) => (b.sent_at ? new Date(b.sent_at).getTime() : 0) - (a.sent_at ? new Date(a.sent_at).getTime() : 0));
  }, [expandedFlow, rowsByFlow, stepFilter, search]);

  const toggleFlow = (flow: FlowLite) => {
    if (expandedFlow === flow.id) { setExpandedFlow(null); return; }
    setExpandedFlow(flow.id);
    setStepFilter(""); setSearch(""); setExpandedRow(null);
    // Expanding a flow the background fill hasn't reached yet computes it now, so the
    // detail never waits behind the other flows.
    void ensureFlow(flow);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="font-semibold text-foreground">Flows</h3>
        <button onClick={load} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" title="Reload">
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} /> refresh
        </button>
        <span className="ml-auto text-xs text-muted-foreground">Click a flow to see its steps and every email it sent.</span>
      </div>

      {capped && <p className="text-[11px] text-amber-600">A flow with more than {ENR_CAP} enrollments shows only its most recent ones.</p>}

      {loading && <p className="text-sm text-muted-foreground py-8 text-center">Loading flows…</p>}

      {!loading && flows.length === 0 && (
        <div className="text-center py-12 text-muted-foreground text-sm border border-dashed border-border rounded-xl">
          No outreach flows yet.
        </div>
      )}

      {!loading && flows.length > 0 && (
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                <th className="w-8 px-3 py-2" />
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Flow</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Status</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Enrolled</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {flows.map((f) => {
                const open = expandedFlow === f.id;
                return (
                  <Fragment key={f.id}>
                    <tr
                      onClick={() => toggleFlow(f)}
                      className={cn("border-b border-border/50 last:border-0 cursor-pointer hover:bg-muted/20", open && "bg-muted/20")}
                      title="Click to see every email this flow sent, per step"
                    >
                      <td className="px-3 py-2.5 text-muted-foreground">{open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}</td>
                      <td className="px-3 py-2.5">
                        <span className="text-xs font-medium text-foreground">{f.name}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", f.is_active ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                          {f.is_active ? "Active" : "Paused"}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-foreground">{enrolled[f.id] ?? "—"}</td>
                      <td className="px-3 py-2.5 text-right text-[11px] text-muted-foreground/70">{open ? "" : "view"}</td>
                    </tr>

                    {open && (
                      <tr>
                        <td colSpan={5} className="px-4 py-4 bg-muted/10 border-b border-border">
                          {!rowsByFlow[f.id] ? (
                            <p className="text-xs text-muted-foreground text-center py-6 inline-flex items-center gap-1.5 w-full justify-center"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Loading this flow…</p>
                          ) : steps.length === 0 ? (
                            <p className="text-xs text-muted-foreground text-center py-6">No emails sent in this flow yet.</p>
                          ) : (
                            <div className="flex flex-col gap-3">
                              {/* Where every queued email actually stands. These four are
                                  mutually exclusive: a failed email is NOT counted in sent. */}
                              {(() => {
                                const all = rowsByFlow[f.id] || [];
                                const tot = rollup(all);
                                const fails = all.filter((r) => r.status === "failed");
                                // Group the failure reasons so "why did 84 fail" is answerable
                                // at a glance instead of opening them one by one.
                                const reasons = new Map<string, number>();
                                for (const r of fails) {
                                  const key = (r.error || "Unknown error")
                                    .replace(/\s+/g, " ")
                                    .replace(/^Error:\s*/i, "")
                                    .slice(0, 120);
                                  reasons.set(key, (reasons.get(key) || 0) + 1);
                                }
                                const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]);
                                return (
                                  <>
                                    <div className="flex flex-wrap items-center gap-2 text-xs">
                                      <span className="px-2 py-1 rounded-md border border-border bg-background">
                                        <b className="text-foreground">{all.length}</b> <span className="text-muted-foreground">queued total</span>
                                      </span>
                                      <span className="px-2 py-1 rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700">
                                        <b>{tot.sent}</b> delivered to SMTP
                                      </span>
                                      {tot.failed > 0 && (
                                        <span className="px-2 py-1 rounded-md border border-red-300 bg-red-50 dark:bg-red-950/20 text-red-700">
                                          <b>{tot.failed}</b> failed
                                        </span>
                                      )}
                                      {tot.waiting > 0 && (
                                        <span className="px-2 py-1 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 text-amber-700">
                                          <b>{tot.waiting}</b> waiting for later
                                        </span>
                                      )}
                                      {tot.suppressed > 0 && (
                                        <span className="px-2 py-1 rounded-md border border-border bg-muted/40 text-muted-foreground">
                                          <b>{tot.suppressed}</b> suppressed
                                        </span>
                                      )}
                                      <span className="text-[11px] text-muted-foreground/70">these don't overlap — failed is not part of delivered</span>
                                    </div>

                                    {top.length > 0 && (
                                      <div className="rounded-lg border border-red-200 bg-red-50/50 dark:bg-red-950/10 p-3">
                                        <p className="text-xs font-medium text-red-700 mb-1.5 inline-flex items-center gap-1.5">
                                          <AlertTriangle className="w-3.5 h-3.5" /> Why {tot.failed} failed
                                        </p>
                                        <div className="space-y-1">
                                          {top.slice(0, 6).map(([reason, n]) => (
                                            <div key={reason} className="flex items-start gap-2 text-[11px]">
                                              <span className="font-semibold text-red-700 shrink-0 tabular-nums w-8">{n}×</span>
                                              <span className="text-foreground/80 break-all">{reason}</span>
                                            </div>
                                          ))}
                                        </div>
                                        <p className="text-[11px] text-muted-foreground mt-2">
                                          Failed means the mail server rejected it after 5 tries. The exact text above is what it said.
                                        </p>
                                      </div>
                                    )}

                                    {tot.waiting > 0 && (
                                      <p className="text-[11px] text-amber-700">
                                        {tot.waiting} email{tot.waiting === 1 ? " is" : "s are"} queued but not due yet — either a mailbox hit its daily limit (they resume after the reset at UTC midnight) or the flow's send interval is spacing them out.
                                      </p>
                                    )}
                                  </>
                                );
                              })()}

                              {/* Per-step summary — which email step drives opens/clicks/loads */}
                              <div className="border border-border rounded-lg overflow-hidden bg-background">
                                <table className="w-full text-sm">
                                  <thead className="bg-muted/40 border-b border-border">
                                    <tr>
                                      <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Step</th>
                                      <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Subject</th>
                                      <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Sent</th>
                                      <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Opened</th>
                                      <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Clicked</th>
                                      <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Replied</th>
                                      <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Bounced</th>
                                      <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Loaded page</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {steps.map((s, i) => {
                                      const active = stepFilter === s.node;
                                      return (
                                        <tr
                                          key={s.node}
                                          onClick={() => setStepFilter(active ? "" : s.node)}
                                          className={cn("border-b border-border/50 last:border-0 cursor-pointer hover:bg-muted/20", active && "bg-primary/10")}
                                          title="Click to filter the list below to this step"
                                        >
                                          <td className="px-3 py-2.5 text-xs font-medium text-foreground whitespace-nowrap">
                                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-muted text-[10px] font-bold mr-1.5">{i + 1}</span>
                                            {s.label}
                                          </td>
                                          <td className="px-3 py-2.5 text-xs text-muted-foreground font-mono truncate max-w-[220px]">{s.subject || "—"}</td>
                                          <td className="px-3 py-2.5 text-xs text-foreground">{s.sent}</td>
                                          <Stat n={s.opened} d={s.sent} tone="text-blue-600 font-medium" />
                                          <Stat n={s.clicked} d={s.sent} tone="text-violet-600 font-medium" />
                                          <Stat n={s.replied} d={s.sent} tone="text-rose-600 font-medium" />
                                          <Stat n={s.bounced} d={s.sent} tone={bounceTone(s.bounced, s.sent)} />
                                          <Stat n={s.loaded} d={s.sent} tone="text-amber-600 font-medium" />
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>

                              {/* Per-recipient detail with the exact link clicked */}
                              <div className="flex items-center gap-2">
                                <input
                                  value={search}
                                  onChange={(e) => setSearch(e.target.value)}
                                  placeholder="Search recipient…"
                                  className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm w-56"
                                />
                                {stepFilter && (
                                  <button onClick={() => setStepFilter("")} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                                    <X className="w-3 h-3" /> Step: {stepLabelOf.get(stepFilter)} (clear)
                                  </button>
                                )}
                                <span className="ml-auto text-xs text-muted-foreground">{visibleRows.length} email{visibleRows.length === 1 ? "" : "s"}</span>
                              </div>

                              <div className="border border-border rounded-lg overflow-hidden bg-background">
                                <table className="w-full text-xs">
                                  <thead className="bg-muted/40 border-b border-border">
                                    <tr>
                                      <th className="w-8 px-3 py-2" />
                                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Recipient</th>
                                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Step</th>
                                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Status</th>
                                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Sent at</th>
                                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Opened</th>
                                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Clicked link</th>
                                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Replied</th>
                                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Loaded</th>
                                      <th className="w-8 px-3 py-2" />
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {visibleRows.map((r) => {
                                      const rOpen = expandedRow === r.qid;
                                      const firstClick = r.clicks[0];
                                      const bounced = r.bounces.length > 0;
                                      return (
                                        <Fragment key={r.qid}>
                                          <tr className="border-b border-border/50 last:border-0 hover:bg-muted/20 cursor-pointer" onClick={() => setExpandedRow(rOpen ? null : r.qid)}>
                                            <td className="px-3 py-2 text-muted-foreground">{rOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}</td>
                                            <td className="px-3 py-2">
                                              <p className="font-medium text-foreground">{r.recipient_name || "—"}</p>
                                              <p className="text-muted-foreground">{r.recipient_email}</p>
                                            </td>
                                            <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{stepOrder.get(r.node)}. {stepLabelOf.get(r.node)}</td>
                                            <td className="px-3 py-2">
                                              {/* A bounce outranks the queue status: the worker says "sent", SES says it
                                                  never landed, and the second one is the truth that matters. */}
                                              {bounced ? (
                                                <span className="px-1.5 py-0.5 rounded font-medium bg-red-500/15 text-red-600 inline-flex items-center gap-1">
                                                  <AlertTriangle className="w-3 h-3" /> bounced
                                                </span>
                                              ) : (
                                                <span className={cn("px-1.5 py-0.5 rounded font-medium",
                                                  r.status === "sent" ? "bg-primary/15 text-primary" :
                                                  r.status === "failed" ? "bg-destructive/15 text-destructive" :
                                                  r.status === "sending" ? "bg-accent text-accent-foreground" :
                                                  "bg-amber-500/15 text-amber-600"
                                                )}>{r.status}</span>
                                              )}
                                              {/* The reason, right where the failure is. */}
                                              {r.error && (r.status === "failed" || r.status === "suppressed") && (
                                                <p className="text-[10px] text-destructive/80 mt-1 max-w-[220px] break-all" title={r.error}>
                                                  {r.error.replace(/^Error:\s*/i, "").slice(0, 90)}
                                                </p>
                                              )}
                                              {r.status === "pending" && r.scheduledFor && new Date(r.scheduledFor).getTime() > Date.now() && (
                                                <p className="text-[10px] text-amber-600 mt-1 whitespace-nowrap">due {new Date(r.scheduledFor).toLocaleString()}</p>
                                              )}
                                            </td>
                                            <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{r.sent_at ? new Date(r.sent_at).toLocaleString() : "—"}</td>
                                            <td className="px-3 py-2">{r.opens.length > 0 ? <span className="text-blue-600 font-medium">✓ {r.opens.length}</span> : <span className="text-muted-foreground">—</span>}</td>
                                            <td className="px-3 py-2 max-w-[240px]">
                                              {r.clicks.length > 0 ? (
                                                <span className="text-violet-600 font-medium inline-flex items-center gap-1">
                                                  <MousePointerClick className="w-3 h-3 shrink-0" />
                                                  <span className="truncate">{shortLink(firstClick?.link_url)}{r.clicks.length > 1 ? ` +${r.clicks.length - 1}` : ""}</span>
                                                </span>
                                              ) : <span className="text-muted-foreground">—</span>}
                                            </td>
                                            <td className="px-3 py-2">{r.replied ? <span className="text-rose-600 font-medium">✓</span> : <span className="text-muted-foreground">—</span>}</td>
                                            <td className="px-3 py-2">{r.loaded ? <span className="text-amber-600 font-medium">✓</span> : <span className="text-muted-foreground">—</span>}</td>
                                            <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                                              {r.html_body && (
                                                <button onClick={() => setPreview(r)} title="Preview the exact email" className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground">
                                                  <Eye className="w-3.5 h-3.5" />
                                                </button>
                                              )}
                                            </td>
                                          </tr>
                                          {rOpen && (
                                            <tr>
                                              <td colSpan={10} className="px-4 py-3 bg-muted/20 border-b border-border">
                                                <Timeline row={r} />
                                              </td>
                                            </tr>
                                          )}
                                        </Fragment>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setPreview(null)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col" style={{ maxHeight: "85vh" }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between px-5 py-4 border-b border-border flex-shrink-0">
              <div>
                <p className="font-semibold text-sm text-foreground">{preview.subject || "(no subject)"}</p>
                <p className="text-xs text-muted-foreground mt-0.5">To: {preview.recipient_name} &lt;{preview.recipient_email}&gt;</p>
              </div>
              <button onClick={() => setPreview(null)} className="text-muted-foreground hover:text-foreground ml-4 flex-shrink-0"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex-1 overflow-hidden">
              <iframe srcDoc={buildEmailPreviewSrcDoc({ body: preview.html_body || "", format: preview.email_format, trackingImageUrl: preview.tracking_image_url, fill: (s) => s })} className="w-full h-full border-0" style={{ minHeight: "500px" }} sandbox="allow-same-origin" title="Email preview" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Full event timeline for one email — opens, the exact links clicked, the bounce, the load.
function Timeline({ row }: { row: EmailRow }) {
  const events = [
    ...row.opens.map((e) => ({ t: e.created_at, kind: "open" as const, label: "Opened" })),
    ...row.clicks.map((e) => ({ t: e.created_at, kind: "click" as const, label: `Clicked ${e.link_url || "(link)"}` })),
    ...(row.replied ? [{ t: row.repliedAt || row.sent_at || new Date().toISOString(), kind: "reply" as const, label: "Replied" }] : []),
    ...row.bounces.map((e) => ({ t: e.created_at, kind: "bounce" as const, label: "Bounced — Amazon SES could not deliver it, and the address is now suppressed." })),
    ...(row.loadedAt ? [{ t: row.loadedAt, kind: "load" as const, label: "Loaded landing page" }] : []),
  ].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());

  if (events.length === 0) return <p className="text-xs text-muted-foreground">No opens, clicks, replies, or page loads recorded for this email yet.</p>;
  return (
    <ol className="space-y-1.5">
      {events.map((e, i) => (
        <li key={i} className="flex items-start gap-2 text-xs">
          <span className={cn("mt-0.5 shrink-0",
            e.kind === "open" ? "text-blue-600" : e.kind === "click" ? "text-violet-600" : e.kind === "reply" ? "text-rose-600" : e.kind === "bounce" ? "text-red-600" : "text-amber-600")}>
            {e.kind === "open" ? <MailOpen className="w-3.5 h-3.5" /> : e.kind === "click" ? <MousePointerClick className="w-3.5 h-3.5" /> : e.kind === "reply" ? <Reply className="w-3.5 h-3.5" /> : e.kind === "bounce" ? <AlertTriangle className="w-3.5 h-3.5" /> : <span className="inline-block w-3.5 text-center">●</span>}
          </span>
          <span className="text-foreground/80 break-all">{e.label}</span>
          <span className="ml-auto text-muted-foreground whitespace-nowrap shrink-0">{timeOf(e.t)}</span>
        </li>
      ))}
    </ol>
  );
}
