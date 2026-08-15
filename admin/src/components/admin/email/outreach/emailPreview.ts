// Shared email preview renderer. Every preview surface (template editor, flow preview,
// compose, mailbox composer, sent log, follow-up modal) uses this so plain vs HTML,
// merge tags, and the {{tracked_image}} tag all render the same way — and match what the
// send worker (process-email-queue) actually produces.

// Sample values so a preview reads like a real, personalized email without needing a
// contact or campaign. Keys mirror the {{placeholders}} the composer offers.
export const DEMO_VARS: Record<string, string> = {
  business_name: "Glow Med Spa", name: "Glow Med Spa", first_name: "Glow",
  category: "Medical spa", city: "Austin", state: "TX",
  website: "glowmedspa.com", phone: "(512) 555-0142",
  rating: "4.8", review_count: "212", email: "hello@glowmedspa.com",
  unsubscribe_url: "#",
  // Sender tags are filled at send time from the mailbox that sends; here we just show a
  // stand-in persona so the sign-off previews sensibly.
  sender_name: "Justin Hociun", sender_first_name: "Justin", sender_last_name: "Hociun",
  sender_email: "justin@yourdomain.com",
};

// Fill {{tags}} with demo values. Unknown tags are left as {{tag}} so nothing silently
// vanishes; the tracked-image tag is intentionally NOT matched here (colon/spacing form)
// so resolveTrackedImage can handle it after escaping.
export function fillDemo(s: string): string {
  return (s || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => DEMO_VARS[k] ?? `{{${k}}}`);
}

export function escapeHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Replace {{tracked_image}} / {{tracked_image:width}} with the real image (when a URL is
// set) or a dashed placeholder (when not). Width/style mirror the send worker so the
// preview is faithful. Safe to call on already-escaped text: it only touches the tag.
export function resolveTrackedImage(str: string, url?: string | null): string {
  const re = /\{\{\s*tracked_image(?::(\d+))?\s*\}\}/gi;
  return (str || "").replace(re, (_m, w) => {
    const width = w ? Math.min(Math.max(parseInt(w, 10), 40), 1200) : 480;
    if (url) return `<img src="${url}" alt="" style="width:100%;max-width:${width}px;height:auto;display:block;border:0;margin:8px 0;" />`;
    return `<div style="max-width:${width}px;border:1px dashed #bbb;border-radius:8px;padding:16px;text-align:center;color:#999;font-size:12px;margin:8px 0;">Tracked image</div>`;
  });
}

const DOC_STYLES = "body{margin:0;padding:20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;background:#fff;}img{max-width:100%;height:auto;}a{color:#2563eb;}";

// Build a full srcDoc for a preview iframe.
//  - format "plain" => escape + white-space:pre-wrap so spaces/blank lines survive.
//  - otherwise      => render the HTML as-is.
// The {{tracked_image}} tag renders as the real image (or a placeholder) in both modes.
// `fill` is the merge-tag filler; defaults to demo values. Pass a real filler (e.g. the
// contact's values) when previewing a specific recipient.
export function buildEmailPreviewSrcDoc(opts: {
  body: string;
  format?: string | null;
  trackingImageUrl?: string | null;
  fill?: (s: string) => string;
}): string {
  const { body, format, trackingImageUrl, fill = fillDemo } = opts;
  const isPlain = format === "plain";
  let inner: string;
  if (isPlain) {
    // Escape the text so it renders literally, then drop the image in at the tag's spot.
    const text = resolveTrackedImage(escapeHtml(fill(body || "")), trackingImageUrl);
    inner = `<div style="white-space:pre-wrap;word-wrap:break-word;">${text}</div>`;
  } else {
    inner = resolveTrackedImage(fill(body || ""), trackingImageUrl);
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>${DOC_STYLES}</style></head><body>${inner}</body></html>`;
}
