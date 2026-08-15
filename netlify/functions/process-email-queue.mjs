import nodemailer from "nodemailer";
import {
  admin, json, siteBase, applySenderVars, injectTracking, htmlToText,
  plainTextToHtml, threadKey, snippet,
} from "../lib/shared.mjs";

const BATCH = 20;

// Runs every minute (schedule below) and on demand via /api/process-email-queue.
export default async () => {
  const sb = admin();
  const now = new Date().toISOString();

  // Reclaim leases from a crashed run.
  await sb.from("email_queue").update({ status: "pending" })
    .eq("status", "sending").lte("scheduled_for", now);

  const { data: items } = await sb.from("email_queue")
    .select("*").eq("status", "pending").lte("scheduled_for", now)
    .order("scheduled_for", { ascending: true }).limit(BATCH);
  if (!items?.length) return json({ processed: 0 });

  // Lease.
  const lease = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await sb.from("email_queue").update({ status: "sending", scheduled_for: lease })
    .in("id", items.map((i) => i.id));

  // Blacklist.
  const emails = [...new Set(items.map((i) => i.recipient_email.toLowerCase()))];
  const { data: bl } = await sb.from("email_blacklist").select("email").in("email", emails);
  const blocked = new Set((bl || []).map((r) => r.email.toLowerCase()));

  // Load senders referenced by this batch.
  const senderIds = [...new Set(items.map((i) => i.sender_account_id).filter(Boolean))];
  let senders = [];
  if (senderIds.length) ({ data: senders } = await sb.from("email_sender_accounts").select("*").in("id", senderIds));
  const senderMap = new Map((senders || []).map((s) => [s.id, s]));
  let fallback = null;
  if (items.some((i) => !i.sender_account_id)) {
    ({ data: fallback } = await sb.from("email_sender_accounts")
      .select("*").eq("is_active", true).order("is_default", { ascending: false }).limit(1).maybeSingle());
  }

  const transports = new Map();
  const getTransport = (s) => {
    if (!transports.has(s.id)) {
      transports.set(s.id, nodemailer.createTransport({
        host: s.smtp_host, port: s.smtp_port, secure: s.smtp_port === 465,
        requireTLS: s.smtp_port === 587, auth: { user: s.smtp_user, pass: s.smtp_password },
      }));
    }
    return transports.get(s.id);
  };

  const base = siteBase();
  const dailyCount = new Map();
  let sent = 0, failed = 0, skipped = 0;

  for (const item of items) {
    if (blocked.has(item.recipient_email.toLowerCase())) {
      await sb.from("email_queue").update({ status: "failed", error_message: "blacklisted", sent_at: now }).eq("id", item.id);
      continue;
    }
    const sender = (item.sender_account_id && senderMap.get(item.sender_account_id)) || fallback;
    if (!sender) {
      await sb.from("email_queue").update({ status: "failed", error_message: "no active sender" }).eq("id", item.id);
      failed++; continue;
    }

    // Daily limit per sender (rolling 24h).
    if (!dailyCount.has(sender.id)) {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { count } = await sb.from("email_queue")
        .select("id", { count: "exact", head: true })
        .eq("sender_account_id", sender.id).eq("status", "sent").gte("sent_at", since);
      dailyCount.set(sender.id, count || 0);
    }
    if (dailyCount.get(sender.id) >= (sender.daily_limit || 50)) {
      // Hold for the next window instead of sending over the cap.
      await sb.from("email_queue").update({
        status: "pending",
        scheduled_for: new Date(Date.now() + 3600 * 1000).toISOString(),
      }).eq("id", item.id);
      skipped++; continue;
    }

    try {
      const subject = applySenderVars(item.subject, sender);
      const rawBody = applySenderVars(item.html_body, sender);
      const isPlain = item.email_format === "plain";
      let html, text;
      if (isPlain) {
        // Plain text: send the raw text (newlines/blank lines intact) as the text
        // part, and a pre-wrap HTML mirror only when we need to carry the open pixel.
        text = rawBody;
        if (item.track_opens !== false) {
          html = injectTracking(plainTextToHtml(rawBody), item.id, item.tracking_token, {
            trackOpens: true, trackClicks: false,
          });
        }
      } else {
        html = injectTracking(rawBody, item.id, item.tracking_token, {
          trackOpens: item.track_opens !== false, trackClicks: true,
        });
        text = htmlToText(html);
      }
      const headers = {};
      if (item.include_unsubscribe !== false) {
        const unsub = `${base}/unsubscribe?email=${encodeURIComponent(item.recipient_email)}${item.outreach_campaign_id ? `&cid=${item.outreach_campaign_id}` : ""}`;
        headers["List-Unsubscribe"] = `<mailto:${sender.from_email}?subject=unsubscribe>, <${unsub}>`;
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
      }

      const info = await getTransport(sender).sendMail({
        from: `"${sender.from_name}" <${sender.from_email}>`,
        to: item.recipient_name ? `"${item.recipient_name}" <${item.recipient_email}>` : item.recipient_email,
        subject, html, text, headers,
        inReplyTo: item.in_reply_to || undefined,
        references: item.references_header || undefined,
      });

      await sb.from("email_queue").update({ status: "sent", sent_at: new Date().toISOString(), error_message: null }).eq("id", item.id);
      dailyCount.set(sender.id, dailyCount.get(sender.id) + 1);
      sent++;

      // Record outbound in the shadow mailbox.
      await sb.from("mailbox_messages").insert({
        direction: "outbound", contact_id: item.outreach_contact_id || null, queue_item_id: item.id,
        thread_key: threadKey(item.recipient_email, subject), message_id: info.messageId || null,
        from_email: sender.from_email, from_name: sender.from_name, to_email: item.recipient_email,
        subject, snippet: snippet(html, text), body_text: text, body_html: html, seen: true,
        occurred_at: new Date().toISOString(),
      });

      if (item.outreach_campaign_id) {
        await sb.rpc("increment_outreach_sent", { campaign_id: item.outreach_campaign_id });
      }
    } catch (e) {
      const attempts = (item.attempts || 0) + 1;
      await sb.from("email_queue").update({
        status: attempts >= 3 ? "failed" : "pending",
        attempts, error_message: String(e?.message || e).slice(0, 300),
        scheduled_for: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }).eq("id", item.id);
      failed++;
    }
  }

  // Mark fully-drained campaigns as sent.
  const campIds = [...new Set(items.map((i) => i.outreach_campaign_id).filter(Boolean))];
  for (const cid of campIds) {
    const { count } = await sb.from("email_queue")
      .select("id", { count: "exact", head: true })
      .eq("outreach_campaign_id", cid).in("status", ["pending", "sending"]);
    if (!count) await sb.from("outreach_campaigns").update({ status: "sent" }).eq("id", cid);
  }

  return json({ processed: items.length, sent, failed, skipped });
};
