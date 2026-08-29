import { admin, json, substituteVars } from "../lib/shared.mjs";

// Enqueue an outreach campaign: resolve recipients, personalize, stamp a sender,
// insert email_queue rows. The send worker (process-email-queue) delivers them.
export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const sb = admin();
  try {
    const { outreach_campaign_id } = await req.json();
    if (!outreach_campaign_id) return json({ error: "outreach_campaign_id required" }, 400);

    const { data: campaign } = await sb
      .from("outreach_campaigns").select("*").eq("id", outreach_campaign_id).single();
    if (!campaign) return json({ error: "campaign not found" }, 404);

    // Resolve recipients.
    let contacts = [];
    if (campaign.contact_ids?.length) {
      ({ data: contacts } = await sb.from("outreach_contacts").select("*").in("id", campaign.contact_ids));
    } else if (campaign.contact_emails?.length) {
      const emails = campaign.contact_emails;
      const { data: existing } = await sb.from("outreach_contacts").select("*").in("email", emails);
      const have = new Set((existing || []).map((c) => c.email));
      const missing = emails.filter((e) => !have.has(e));
      if (missing.length) {
        await sb.from("outreach_contacts").insert(
          missing.map((email) => ({ name: email, email, status: "new", source: "manual_compose" }))
        );
      }
      ({ data: contacts } = await sb.from("outreach_contacts").select("*").in("email", emails));
    } else if (campaign.audience_id) {
      ({ data: contacts } = await sb.from("outreach_contacts").select("*").eq("audience_id", campaign.audience_id));
    }
    contacts = (contacts || []).filter((c) => c.status !== "unsubscribed" && c.status !== "rejected");

    // Drop unsubscribed / blacklisted. PAGED: a plain select caps at 1000 rows,
    // which would silently let suppressed people back into a send.
    const allRows = async (table) => {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from(table).select("email").range(from, from + 999);
        if (error) throw new Error(`${table}: ${error.message}`);
        out.push(...(data || []));
        if ((data || []).length < 1000) break;
      }
      return out;
    };
    const [unsubs, bl] = await Promise.all([allRows("outreach_unsubscribes"), allRows("email_blacklist")]);
    const blocked = new Set([...unsubs, ...bl].map((r) => (r.email || "").toLowerCase()));
    const recipients = contacts.filter((c) => c.email && !blocked.has(c.email.toLowerCase()));

    if (!recipients.length) {
      await sb.from("outreach_campaigns")
        .update({ status: "sent", total_recipients: 0, sent_at: new Date().toISOString() })
        .eq("id", outreach_campaign_id);
      return json({ queued: 0, message: "no eligible recipients" });
    }

    // Spread the campaign across the group's mailboxes, one per recipient, so a
    // big send doesn't pile onto a single sender and stall at its daily cap.
    const pool = await resolveSenderPool(sb, campaign);

    const rows = recipients.map((c, i) => ({
      queue_type: "outreach",
      outreach_campaign_id: campaign.id,
      outreach_contact_id: c.id,
      sender_account_id: pool.length ? pool[i % pool.length] : null,
      template_id: campaign.template_id || null,
      recipient_email: c.email,
      recipient_name: c.name,
      subject: substituteVars(campaign.subject, c, { campaignId: campaign.id }),
      html_body: substituteVars(campaign.body_html, c, { campaignId: campaign.id }),
      email_format: campaign.email_format || "html",
      include_unsubscribe: campaign.include_unsubscribe !== false,
      track_opens: campaign.track_opens !== false,
      tracking_image_url: campaign.tracking_image_url || null,
      status: "pending",
    }));

    // Insert in chunks.
    let queued = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from("email_queue").insert(rows.slice(i, i + 200));
      if (error) throw error;
      queued += Math.min(200, rows.length - i);
    }

    await sb.from("outreach_campaigns")
      .update({ status: "sending", total_recipients: recipients.length, sent_at: new Date().toISOString() })
      .eq("id", outreach_campaign_id);
    // Only move "new" forward: overwriting every recipient with "contacted" would
    // wipe replied/interested/customer and keep chasing people who already answered.
    await sb.from("outreach_contacts")
      .update({ last_contacted_at: new Date().toISOString(), status: "contacted" })
      .eq("status", "new")
      .in("id", recipients.map((r) => r.id));
    // Everyone else just gets their last-contacted stamp refreshed.
    await sb.from("outreach_contacts")
      .update({ last_contacted_at: new Date().toISOString() })
      .neq("status", "new")
      .in("id", recipients.map((r) => r.id));

    // Kick the queue immediately (the scheduled worker also drains every minute).
    return json({ queued });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
};

/**
 * The mailboxes this campaign may send from, in rotation order. An explicit
 * account pins to just that one; otherwise the campaign's group (or the default
 * group) is rotated, starting from the group's cursor so consecutive campaigns
 * don't all begin on the same mailbox.
 */
async function resolveSenderPool(sb, campaign) {
  if (campaign.sender_account_id) return [campaign.sender_account_id];

  let groupId = campaign.sender_group_id;
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
      const ids = senders.map((s) => s.id);
      // Advance the cursor past this campaign so the next one starts elsewhere.
      await sb.from("sender_groups").update({ rotation_cursor: cursor + ids.length }).eq("id", groupId);
      const start = cursor % ids.length;
      return [...ids.slice(start), ...ids.slice(0, start)];
    }
  }
  const { data: active } = await sb.from("email_sender_accounts")
    .select("id").eq("is_active", true).order("is_default", { ascending: false });
  return (active || []).map((s) => s.id);
}
