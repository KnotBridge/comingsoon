// Single source of truth for merge-tag values on the client.
//
// This MIRRORS netlify/lib/shared.mjs mergeValues() exactly. Compose, the flow
// engine, the mailbox reply and every preview must fill tags identically —
// otherwise what you see is not what the recipient gets. Keep the two in step.

export type MergeMap = Record<string, string>;

const firstToken = (s?: string | null) => (s || "").trim().split(/\s+/)[0] || "";

function str(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return "";
  return String(v);
}

/**
 * Every field a contact carries, as tags. Curated columns first, then anything
 * captured in business_data (so {{ai_relevance_status}}, {{email_count}},
 * {{matched_queries}}, … all work). Curated names always win.
 */
export function contactMergeValues(c: Record<string, unknown> | null | undefined): MergeMap {
  if (!c) return {};
  const cats = c.categories;
  const category =
    (typeof c.primary_category === "string" && c.primary_category) ||
    (Array.isArray(cats) ? str(cats[0]) : "") || "";

  const extra: MergeMap = {};
  const bd = c.business_data as Record<string, unknown> | undefined;
  if (bd && typeof bd === "object" && !Array.isArray(bd)) {
    for (const [k, v] of Object.entries(bd)) {
      const key = String(k).toLowerCase().replace(/[^a-z0-9_]/g, "_");
      if (key) extra[key] = str(v);
    }
  }

  const name = str(c.name);
  return {
    ...extra,
    business_name: name,
    name,
    first_name: firstToken(name),
    category,
    categories: Array.isArray(cats) ? cats.join(", ") : str(cats),
    city: str(c.city),
    state: str(c.state),
    address: str(c.address),
    zip: str(c.postal_code),
    postal_code: str(c.postal_code),
    country: str(c.country_code),
    website: str(c.website_url) || str(c.domain),
    domain: str(c.domain),
    maps_url: str(c.maps_url),
    phone: str(c.phone),
    rating: c.rating != null ? String(c.rating) : "",
    review_count: c.review_count != null ? String(c.review_count) : "",
    email: str(c.email),
  };
}

/** Tags the send worker fills later — never substitute or strip these here. */
export const DEFERRED_TAG_RE = /^(sender_|tracked_image|dynamic_image)/i;

/**
 * Replace {{tags}} from `values`. Unknown tags are dropped so a raw placeholder
 * can never reach a recipient; deferred (sender/image) tags are left intact.
 */
export function fillMergeTags(template: string, values: MergeMap): string {
  return (template || "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (raw, key: string) => {
    const k = key.toLowerCase();
    if (DEFERRED_TAG_RE.test(k)) return raw;
    const v = values[k];
    return v == null ? "" : v;
  });
}

/** The tags offered in the pickers, in the order they're shown. */
export const CORE_TAGS: { tag: string; desc: string }[] = [
  { tag: "business_name", desc: "Business name" },
  { tag: "first_name", desc: "First word of the business name" },
  { tag: "category", desc: "Primary category (e.g. Medical spa)" },
  { tag: "city", desc: "City" },
  { tag: "state", desc: "State" },
  { tag: "address", desc: "Street address" },
  { tag: "zip", desc: "Postal code" },
  { tag: "website", desc: "Website / domain" },
  { tag: "phone", desc: "Phone number" },
  { tag: "rating", desc: "Google rating" },
  { tag: "review_count", desc: "Number of reviews" },
  { tag: "maps_url", desc: "Google Maps link" },
  { tag: "email", desc: "Contact email" },
  { tag: "unsubscribe_url", desc: "Unsubscribe link" },
];

export const SENDER_TAGS: { tag: string; desc: string }[] = [
  { tag: "sender_name", desc: "The sending persona's full name" },
  { tag: "sender_first_name", desc: "The sending persona's first name" },
  { tag: "sender_email", desc: "The sending mailbox's address" },
];
