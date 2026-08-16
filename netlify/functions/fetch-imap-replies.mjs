import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { admin, json, threadKey, snippet } from "../lib/shared.mjs";

// Sync inbound replies for every IMAP-enabled sender into the shadow mailbox,
// with FULL bodies (so the mailbox shows the whole email + thread), and skip
// warm-up traffic:
//   - vendor warm-up (from the trulyinbox tool)  -> from address
//   - warm-up peers (pool signs each mail "Phone_N0:") -> body/subject signature
// Accounts run in parallel with a per-account timeout to stay within limits.
const CONCURRENCY = 12;
const PER_ACCOUNT_MS = 12000;
const MAX_MSGS = 30;
const WINDOW_MS = 3 * 24 * 3600 * 1000;
const WARMUP_RE = /Phone_N0\s*:/i;

async function syncOne(sb, s, since) {
  const client = new ImapFlow({
    host: s.imap_host, port: s.imap_port || 993, secure: (s.imap_port || 993) === 993,
    auth: { user: s.imap_user, pass: s.imap_password }, logger: false,
    connectionTimeout: 8000, greetingTimeout: 7000, socketTimeout: 12000,
  });
  client.on("error", () => {});
  let n = 0, skipped = 0;
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = await client.search({ since }, { uid: true });
    const recent = (uids || []).slice(-MAX_MSGS);
    if (recent.length) {
      for await (const msg of client.fetch(recent, { uid: true, source: true, envelope: true })) {
        try {
          const env = msg.envelope || {};
          const messageId = env.messageId || null;
          if (messageId) {
            const { data: dup } = await sb.from("mailbox_messages").select("id").eq("message_id", messageId).maybeSingle();
            if (dup) continue;
          }
          const fromEmail = ((env.from?.[0]?.address || "") + "").toLowerCase();
          if (fromEmail.includes("trulyinbox")) { skipped++; continue; } // vendor warm-up

          const parsed = await simpleParser(msg.source);
          const text = parsed.text || "";
          const html = parsed.html || null;
          const subject = env.subject || parsed.subject || "";
          if (WARMUP_RE.test(text) || WARMUP_RE.test(html || "") || WARMUP_RE.test(subject)) { skipped++; continue; } // warm-up peer

          const occurred = (env.date ? new Date(env.date) : new Date()).toISOString();
          const { data: contact } = fromEmail
            ? await sb.from("outreach_contacts").select("id").eq("email", fromEmail).maybeSingle()
            : { data: null };

          await sb.from("mailbox_messages").insert({
            direction: "inbound", contact_id: contact?.id || null, message_id: messageId,
            in_reply_to: env.inReplyTo || null, thread_key: threadKey(fromEmail, subject),
            from_email: fromEmail, from_name: env.from?.[0]?.name || null, to_email: s.from_email,
            subject, snippet: snippet(html, text), body_text: text, body_html: html,
            seen: false, occurred_at: occurred,
          });
          if (contact?.id) {
            await sb.from("outreach_replies").insert({ contact_id: contact.id, direction: "inbound", subject, body: text, replied_at: occurred });
            await sb.from("outreach_contacts").update({ status: "replied" }).eq("id", contact.id);
          }
          n++;
        } catch (e) {
          console.error("imap msg", e?.message);
        }
      }
    }
  } finally {
    lock.release();
  }
  await client.logout().catch(() => {});
  return n;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

export default async () => {
  const sb = admin();
  const { data: senders } = await sb.from("email_sender_accounts")
    .select("id,from_email,imap_host,imap_user,imap_password,imap_port")
    .eq("imap_enabled", true).eq("is_active", true);
  if (!senders?.length) return json({ processed: 0, mailboxes: 0 });

  const since = new Date(Date.now() - WINDOW_MS);
  const queue = senders.filter((s) => s.imap_host && s.imap_user && s.imap_password);
  let imported = 0, ok = 0, failed = 0;

  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      try { imported += await withTimeout(syncOne(sb, s, since), PER_ACCOUNT_MS); ok++; }
      catch (e) { failed++; console.error("imap", s.from_email, e?.message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  return json({ processed: imported, mailboxes: senders.length, ok, failed });
};
