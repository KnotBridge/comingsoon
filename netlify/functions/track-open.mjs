import { admin, GIF } from "../lib/shared.mjs";

const gif = () =>
  new Response(GIF, {
    headers: {
      "content-type": "image/gif",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      pragma: "no-cache",
    },
  });

export default async (req) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const token = url.searchParams.get("t");
  if (!id || !token) return gif();
  try {
    const sb = admin();
    const { data: q } = await sb.from("email_queue")
      .select("id, outreach_campaign_id, recipient_email, tracking_token")
      .eq("id", id).eq("tracking_token", token).maybeSingle();
    if (!q) return gif();

    const { count } = await sb.from("email_events")
      .select("id", { count: "exact", head: true })
      .eq("queue_item_id", id).eq("event_type", "open");
    const firstOpen = (count ?? 0) === 0;

    await sb.from("email_events").insert({
      queue_item_id: id, campaign_id: q.outreach_campaign_id, recipient_email: q.recipient_email,
      event_type: "open", user_agent: req.headers.get("user-agent") || null,
      ip_address: req.headers.get("x-forwarded-for") || req.headers.get("x-nf-client-connection-ip") || null,
    });
    if (firstOpen && q.outreach_campaign_id) {
      await sb.rpc("increment_outreach_open", { campaign_id: q.outreach_campaign_id });
    }
  } catch (e) {
    console.error("track-open", e);
  }
  return gif();
};
