import { admin } from "../lib/shared.mjs";

const page = (msg) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
   <title>Unsubscribe</title>
   <div style="font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 24px;text-align:center;color:#111">
     <div style="width:44px;height:44px;border-radius:12px;background:#ffe9ef;color:#ff0048;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:22px">✓</div>
     <h1 style="font-size:20px;margin:0 0 8px">${msg}</h1>
     <p style="color:#666;font-size:14px">You can close this page.</p>
   </div>`,
  { headers: { "content-type": "text/html; charset=utf-8" } }
);

export default async (req) => {
  const url = new URL(req.url);
  const email = (url.searchParams.get("email") || "").toLowerCase().trim();
  const cid = url.searchParams.get("cid");
  if (!email) return page("Invalid unsubscribe link.");
  try {
    const sb = admin();
    const { data: contact } = await sb.from("outreach_contacts").select("id").eq("email", email).maybeSingle();
    await sb.from("outreach_unsubscribes").upsert(
      { email, contact_id: contact?.id || null }, { onConflict: "email" }
    );
    await sb.from("email_blacklist").upsert({ email, reason: "unsubscribed" }, { onConflict: "email" });
    if (contact?.id) {
      await sb.from("outreach_contacts").update({ status: "unsubscribed" }).eq("id", contact.id);
    }
  } catch (e) {
    console.error("unsubscribe", e);
  }
  return page("You've been unsubscribed.");
};
