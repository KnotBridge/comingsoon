// Scheduled trigger for IMAP reply sync (every 5 minutes). The HTTP-callable
// fetch-imap-replies powers the app's "Sync inbox" button.
import handler from "./fetch-imap-replies.mjs";

export default async () => {
  try { await handler(new Request("http://cron", { method: "POST" })); }
  catch (e) { console.error("cron-imap", e?.message); }
};

export const config = { schedule: "*/5 * * * *" };
