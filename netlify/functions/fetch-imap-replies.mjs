import { ImapFlow } from "imapflow";
import { admin, json, threadKey } from "../lib/shared.mjs";

// Sync inbound replies for every IMAP-enabled sender into the shadow mailbox.
// Runs accounts in PARALLEL with a strict per-account timeout, and uses envelope
// data only (no per-message body download) so 20+ inboxes finish inside a
// serverless function's time limit. The scheduled run keeps it current.
const CONCURRENCY = 25; // all accounts in one batch -> total time ≈ slowest account
const PER_ACCOUNT_MS = 7000;
const MAX_MSGS = 40;
const WINDOW_MS = 2 * 24 * 3600 * 1000;

async function syncOne(sb, s, since) {
  const client = new ImapFlow({
    host: s.imap_host, port: s.imap_port || 993, secure: (s.imap_port || 993) === 993,
    auth: { user: s.imap_user, pass: s.imap_password }, logger: false,
    connectionTimeout: 7000, greetingTimeout: 6000, socketTimeout: 8000,
  });
  // ImapFlow emits 'error' on socket faults; without a listener Node crashes the
  // whole function. Swallow it here — the operation promise still rejects and is
  // caught per-account by the caller.
  client.on("error", () => {});
  let n = 0;
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = await client.search({ since }, { uid: true });
    const recent = (uids || []).slice(-MAX_MSGS);
    if (recent.length) {
      for await (const msg of client.fetch(recent, { envelope: true, uid: true })) {
        const env = msg.envelope || {};
        const messageId = env.messageId || null;
        if (messageId) {
          const { data: dup } = await sb.from("mailbox_messages").select("id").eq("message_id", messageId).maybeSingle();
          if (dup) continue;
        }
        const from = env.from?.[0] || {};
        const fromEmail = ((from.address || "") + "").toLowerCase();
        const subject = env.subject || "";
        const occurred = (env.date ? new Date(env.date) : new Date()).toISOString();
        const { data: contact } = fromEmail
          ? await sb.from("outreach_contacts").select("id").eq("email", fromEmail).maybeSingle()
          : { data: null };
        await sb.from("mailbox_messages").insert({
          direction: "inbound", contact_id: contact?.id || null, message_id: messageId,
          in_reply_to: env.inReplyTo || null, thread_key: threadKey(fromEmail, subject),
          from_email: fromEmail, from_name: from.name || null, to_email: s.from_email,
          subject, snippet: subject.slice(0, 200), body_text: null, body_html: null,
          seen: false, occurred_at: occurred,
        });
        if (contact?.id) {
          await sb.from("outreach_replies").insert({ contact_id: contact.id, direction: "inbound", subject, body: null, replied_at: occurred });
          await sb.from("outreach_contacts").update({ status: "replied" }).eq("id", contact.id);
        }
        n++;
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
      try {
        imported += await withTimeout(syncOne(sb, s, since), PER_ACCOUNT_MS);
        ok++;
      } catch (e) {
        failed++;
        console.error("imap", s.from_email, e?.message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  return json({ processed: imported, mailboxes: senders.length, ok, failed });
};
