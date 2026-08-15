// Scheduled trigger for the flow engine (auto-enroll + advance due enrollments).
import handler from "./process-email-flows.mjs";

export default async () => {
  try { await handler(new Request("http://cron", { method: "POST" })); }
  catch (e) { console.error("cron-flows", e?.message); }
};

export const config = { schedule: "* * * * *" };
