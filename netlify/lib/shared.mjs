import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://cjvchubyctljddfwxqcj.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function admin() {
  if (!SERVICE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

// Absolute site origin for links inside emails. Netlify injects URL at runtime.
export function siteBase() {
  return (process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.SITE_URL || "").replace(/\/$/, "");
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const firstToken = (s) => (s || "").trim().split(/\s+/)[0] || "";

// General-business merge values for a contact row.
export function mergeValues(c) {
  const cat = c.primary_category || (Array.isArray(c.categories) ? c.categories[0] : "") || "";
  return {
    business_name: c.name || "",
    name: c.name || "",
    first_name: firstToken(c.name),
    category: cat,
    city: c.city || "",
    state: c.state || "",
    website: c.website_url || c.domain || "",
    phone: c.phone || "",
    rating: c.rating != null ? String(c.rating) : "",
    review_count: c.review_count != null ? String(c.review_count) : "",
    email: c.email || "",
  };
}

// Substitute {{tag}} tokens in a template for one contact. unsubscribe_url is
// built from the campaign + recipient so the recipient can opt out.
export function substituteVars(template, contact, opts = {}) {
  if (!template) return template || "";
  const v = mergeValues(contact);
  let out = template;
  for (const [k, val] of Object.entries(v)) {
    out = out.replace(new RegExp("\\{\\{\\s*" + k + "\\s*\\}\\}", "gi"), val || "");
  }
  const unsub = `${siteBase()}/unsubscribe?email=${encodeURIComponent(contact.email || "")}${
    opts.campaignId ? `&cid=${opts.campaignId}` : ""
  }`;
  out = out.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsub);
  // Drop any leftover unknown tags so recipients never see raw {{...}}.
  out = out.replace(/\{\{\s*[a-z_]+\s*\}\}/gi, "");
  return out;
}

// Sender-persona tags resolved at send time so rotation/fallback stays correct.
export function applySenderVars(text, sender) {
  if (!text) return text || "";
  const full = (sender.from_name || "").trim();
  const parts = full.split(/\s+/).filter(Boolean);
  return text
    .replace(/\{\{\s*sender_(?:full_)?name\s*\}\}/gi, full)
    .replace(/\{\{\s*sender_first_name\s*\}\}/gi, parts[0] || "")
    .replace(/\{\{\s*sender_last_name\s*\}\}/gi, parts.slice(1).join(" "))
    .replace(/\{\{\s*sender_email\s*\}\}/gi, sender.from_email || "");
}

function pixelUrl(id, token) {
  return `${siteBase()}/t/o?id=${id}&t=${token}`;
}
function clickUrl(id, token, href, lid) {
  return `${siteBase()}/t/c?id=${id}&t=${token}&lid=${encodeURIComponent(lid)}&u=${encodeURIComponent(href)}`;
}

// Wrap links for click tracking and append the open pixel.
export function injectTracking(html, id, token, { trackClicks = true, trackOpens = true } = {}) {
  let out = html || "";
  if (trackClicks) {
    let i = 0;
    out = out.replace(/<a\s+([^>]*?)href=["']([^"']+)["']([^>]*?)>/gi, (m, pre, href, post) => {
      if (href.startsWith("mailto:") || href.startsWith("tel:") || href.includes("unsubscribe") || href.includes("/t/o") || href.includes("/t/c")) {
        return m;
      }
      return `<a ${pre}href="${clickUrl(id, token, href, "link_" + i++)}"${post}>`;
    });
  }
  if (trackOpens) {
    const pixel = `<img src="${pixelUrl(id, token)}" width="1" height="1" style="display:none;border:0;" alt="" />`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${pixel}</body>`) : out + pixel;
  }
  return out;
}

export function htmlToText(html) {
  return (html || "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normSubject(s) {
  let out = (s || "").toLowerCase().trim();
  while (/^(re|fwd|fw)\s*:\s*/i.test(out)) out = out.replace(/^(re|fwd|fw)\s*:\s*/i, "").trim();
  return out;
}
export function threadKey(email, subject) {
  return `${(email || "").toLowerCase().trim()}::${normSubject(subject)}`;
}
export function snippet(html, text) {
  const base = text || (html || "").replace(/<[^>]+>/g, " ");
  return base.replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

// 1x1 transparent GIF bytes.
export const GIF = Buffer.from(
  "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64"
);
