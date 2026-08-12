import { ImapFlow } from "imapflow";
import { admin, json, threadKey } from "../lib/shared.mjs";

// Pull recent inbound mail for every sender with IMAP enabled and file it into
// the shadow mailbox + outreach_replies, matched to a contact by sender address.
// Uses IMAP envelope + a best-effort text part (no external MIME parser).
export default async () => {
  const sb = admin();
  const { data: senders } = await sb.from("email_sender_accounts")
    .select("*").eq("imap_enabled", true).eq("is_active", true);
  if (!senders?.length) return json({ processed: 0, mailboxes: 0 });

  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  let imported = 0;

  for (const s of senders) {
    if (!s.imap_host || !s.imap_user || !s.imap_password) continue;
    const client = new ImapFlow({
      host: s.imap_host, port: s.imap_port || 993, secure: (s.imap_port || 993) === 993,
      auth: { user: s.imap_user, pass: s.imap_password }, logger: false,
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        for await (const msg of client.fetch({ since }, { envelope: true, uid: true })) {
          try {
            const env = msg.envelope || {};
            const messageId = env.messageId || null;
            if (messageId) {
              const { data: dup } = await sb.from("mailbox_messages").select("id").eq("message_id", messageId).maybeSingle();
              if (dup) continue;
            }
            const fromAddr = env.from?.[0] || {};
            const fromEmail = ((fromAddr.address || "") + "").toLowerCase();
            const fromName = fromAddr.name || null;
            const subject = env.subject || "";

            // Best-effort plain-text body.
            let bodyText = "";
            try {
              const dl = await client.download(msg.seq, "1", { uid: false });
              if (dl?.content) {
                const chunks = [];
                for await (const ch of dl.content) chunks.push(ch);
                bodyText = Buffer.concat(chunks).toString("utf8").slice(0, 5000);
              }
            } catch { /* envelope-only is fine */ }

            const { data: contact } = fromEmail
              ? await sb.from("outreach_contacts").select("id").eq("email", fromEmail).maybeSingle()
              : { data: null };

            await sb.from("mailbox_messages").insert({
              direction: "inbound", contact_id: contact?.id || null, message_id: messageId,
              in_reply_to: env.inReplyTo || null, thread_key: threadKey(fromEmail, subject),
              from_email: fromEmail, from_name: fromName, to_email: s.from_email,
              subject, snippet: (bodyText || subject).slice(0, 200), body_text: bodyText, body_html: null,
              seen: false, occurred_at: (env.date ? new Date(env.date) : new Date()).toISOString(),
            });
            if (contact?.id) {
              await sb.from("outreach_replies").insert({
                contact_id: contact.id, direction: "inbound", subject, body: bodyText,
                replied_at: (env.date ? new Date(env.date) : new Date()).toISOString(),
              });
              await sb.from("outreach_contacts").update({ status: "replied" }).eq("id", contact.id);
            }
            imported++;
          } catch (e) {
            console.error("imap msg", e?.message);
          }
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (e) {
      console.error(`imap ${s.from_email}`, e?.message);
      try { await client.close(); } catch {}
    }
  }
  return json({ processed: imported, mailboxes: senders.length });
};

export const config = { schedule: "*/5 * * * *" };
