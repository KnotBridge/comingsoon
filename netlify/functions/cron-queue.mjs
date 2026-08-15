// Scheduled trigger for the send queue. Netlify scheduled functions can't be
// invoked over HTTP, so the actual worker (process-email-queue) stays HTTP-only
// for the app's "Send now", and this thin wrapper runs it on a cron.
import handler from "./process-email-queue.mjs";

export default async () => {
  try { await handler(new Request("http://cron", { method: "POST" })); }
  catch (e) { console.error("cron-queue", e?.message); }
};

export const config = { schedule: "* * * * *" };
