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

    // Drop unsubscribed / blacklisted.
    const [{ data: unsubs }, { data: bl }] = await Promise.all([
      sb.from("outreach_unsubscribes").select("email"),
      sb.from("email_blacklist").select("email"),
    ]);
    const blocked = new Set([...(unsubs || []), ...(bl || [])].map((r) => r.email.toLowerCase()));
    const recipients = contacts.filter((c) => c.email && !blocked.has(c.email.toLowerCase()));

    if (!recipients.length) {
      await sb.from("outreach_campaigns")
        .update({ status: "sent", total_recipients: 0, sent_at: new Date().toISOString() })
        .eq("id", outreach_campaign_id);
      return json({ queued: 0, message: "no eligible recipients" });
    }

    // Pick a sender to stamp on each row: explicit account, else rotate the group.
    const senderId = await resolveSender(sb, campaign);

    const rows = recipients.map((c) => ({
      queue_type: "outreach",
      outreach_campaign_id: campaign.id,
      outreach_contact_id: c.id,
      sender_account_id: senderId,
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
    await sb.from("outreach_contacts")
      .update({ last_contacted_at: new Date().toISOString(), status: "contacted" })
      .in("id", recipients.map((r) => r.id));

    // Kick the queue immediately (the scheduled worker also drains every minute).
    return json({ queued });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
};

async function resolveSender(sb, campaign) {
  if (campaign.sender_account_id) return campaign.sender_account_id;
  const groupId = campaign.sender_group_id;
  if (groupId) {
    const { data: senders } = await sb.from("email_sender_accounts")
      .select("id").eq("group_id", groupId).eq("is_active", true).order("created_at");
    if (senders?.length) {
      const { data: grp } = await sb.from("sender_groups").select("rotation_cursor").eq("id", groupId).maybeSingle();
      const cursor = grp?.rotation_cursor ?? 0;
      const pick = senders[cursor % senders.length].id;
      await sb.from("sender_groups").update({ rotation_cursor: cursor + 1 }).eq("id", groupId);
      return pick;
    }
  }
  // Fallback: default or any active sender.
  const { data: def } = await sb.from("email_sender_accounts")
    .select("id").eq("is_active", true).order("is_default", { ascending: false }).limit(1).maybeSingle();
  return def?.id || null;
}
