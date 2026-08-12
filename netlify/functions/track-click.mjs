import { admin } from "../lib/shared.mjs";

const redirect = (to) =>
  new Response(null, {
    status: 302,
    headers: { location: to, "cache-control": "no-store, no-cache, must-revalidate, max-age=0" },
  });

export default async (req) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const token = url.searchParams.get("t");
  const lid = url.searchParams.get("lid");
  const dest = url.searchParams.get("u");
  const safe = dest && /^https?:\/\//i.test(dest) ? dest : "https://rnq.agency";

  try {
    const sb = admin();
    const { data: q } = await sb.from("email_queue")
      .select("id, outreach_campaign_id, recipient_email, tracking_token")
      .eq("id", id).eq("tracking_token", token).maybeSingle();
    if (q) {
      const { count } = await sb.from("email_events")
        .select("id", { count: "exact", head: true })
        .eq("queue_item_id", id).eq("event_type", "click");
      await sb.from("email_events").insert({
        queue_item_id: id, campaign_id: q.outreach_campaign_id, recipient_email: q.recipient_email,
        event_type: "click", link_id: lid || null, link_url: safe,
        user_agent: req.headers.get("user-agent") || null,
      });
      // Bump click_count once per queue item (first click only).
      if ((count ?? 0) === 0 && q.outreach_campaign_id) {
        const { data: c } = await sb.from("outreach_campaigns")
          .select("click_count").eq("id", q.outreach_campaign_id).maybeSingle();
        await sb.from("outreach_campaigns")
          .update({ click_count: (c?.click_count || 0) + 1 }).eq("id", q.outreach_campaign_id);
      }
    }
  } catch (e) {
    console.error("track-click", e);
  }
  return redirect(safe);
};
