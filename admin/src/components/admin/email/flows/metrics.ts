// Single source of truth for turning flow email_events into metrics. Every flow
// view (builder funnel, per-card, Sent Log) MUST classify events through these
// helpers so the numbers can never disagree across screens.
//
// The rules, and why:
//  - OPEN: any `open` event counts. Opens are fetched by mail-render proxies
//    (Gmail's GoogleImageProxy, Apple Mail Privacy) — that proxy fetch IS how an
//    open is recorded, so we must NOT treat it as a bot or we'd zero real opens.
//    Opens are inherently approximate (proxies pre-fetch), but they are counted
//    identically everywhere.
//  - CLICK: a `click` event counts only if it is NOT from a known security
//    scanner / link-preview bot (Outlook SafeLinks, Mimecast, Proofpoint, etc.).
//    Those fire with no human and would inflate the click rate.
//  - LOAD: a `page_view` event counts. These are written by the re-visit beacon,
//    which already excludes bots server-side and is attributed to THIS email, so
//    "loaded" means the same per-email thing in the funnel, the card, and the log.

export const BOT_RE =
  /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|facebot|whatsapp|telegram|slackbot|discordbot|linkedinbot|twitterbot|preview|prefetch|scan(ner)?|proofpoint|mimecast|barracuda|messagelabs|symantec|forcepoint|cloudmark|safelinks|microsoft-office|ms-office|outlook|headless|phantom|puppeteer|playwright|python-requests|httpclient|curl|wget|axios|go-http|java\/|okhttp|libwww|apache-http/i;

export const isBot = (ua?: string | null) => !!ua && BOT_RE.test(ua);

export interface FlowEvent { event_type: string; user_agent?: string | null }

export const countsAsOpen = (e: FlowEvent) => e.event_type === "open";
export const countsAsClick = (e: FlowEvent) => e.event_type === "click" && !isBot(e.user_agent);
export const countsAsLoad = (e: FlowEvent) => e.event_type === "page_view";
export const countsAsReply = (e: FlowEvent) => e.event_type === "reply";
// BOUNCE: a `bounce` event, written by ses-events on a PERMANENT SES bounce (or an
// up-front Reject). This is the real bounce signal (SES's own feedback), not a guess.
export const countsAsBounce = (e: FlowEvent) => e.event_type === "bounce";

// Columns every flow view should select from email_events so the rules above work.
export const EVENT_SELECT = "queue_item_id,event_type,user_agent";

// One bucket of emails (a whole node, or one A/B variant of a node). Same shape
// the per-node card already uses, so existing consumers keep working unchanged.
export interface EmailBucketStats { queued: number; sent: number; failed: number; opened: number; clicked: number; reached: number; replied: number; bounced: number }
export const emptyBucket = (): EmailBucketStats => ({ queued: 0, sent: 0, failed: 0, opened: 0, clicked: 0, reached: 0, replied: 0, bounced: 0 });
// Per-node stats; `variants` is only present on A/B nodes (the split sub-buckets).
export interface NodeStats extends EmailBucketStats { variants?: { A: EmailBucketStats; B: EmailBucketStats } }
