// Scheduled trigger for IMAP reply sync (every 5 minutes). The HTTP-callable
// fetch-imap-replies powers the app's "Sync inbox" button.
import handler from "./fetch-imap-replies.mjs";

export default async () => {
  try {
    // Scheduled functions may run for minutes, so give the sync a longer budget
    // than the HTTP button (which must stay under Netlify's ~10s sync limit).
    await handler(new Request("http://cron", { method: "POST" }), { budgetMs: 60_000 });
  }
  catch (e) { console.error("cron-imap", e?.message); }
};

export const config = { schedule: "*/5 * * * *" };
