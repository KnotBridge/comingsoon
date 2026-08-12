export interface OutreachAudience {
  id: string;
  name: string;
  description: string | null;
  color: string;
  contact_count: number;
  created_at: string;
  updated_at: string;
}

// General-business contact (Google Maps scrape profile). Curated columns mirror
// the common CSV fields; `business_data` holds the full original record.
export interface OutreachContact {
  id: string;
  audience_id: string | null;
  // identity
  name: string; // business name
  email: string; // primary_email
  all_emails: string[] | null; // emails[]
  // classification
  primary_category: string | null;
  categories: string[] | null;
  // contact channels
  phone: string | null;
  website_url: string | null;
  domain: string | null;
  // location
  address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  // reputation
  rating: number | null;
  review_count: number | null;
  // provenance
  maps_url: string | null;
  place_id: string | null;
  cid: string | null;
  source: string | null;
  // workflow
  status: "new" | "contacted" | "replied" | "interested" | "customer" | "rejected" | "unsubscribed";
  notes: string | null;
  tags: string[] | null;
  last_contacted_at: string | null;
  // lossless catch-all for every remaining scrape field
  business_data?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface OutreachCampaign {
  id: string;
  name: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  sender_account_id: string | null;
  sender_group_id?: string | null;
  audience_id: string | null;
  contact_ids: string[] | null;
  contact_emails: string[] | null;
  track_replies: boolean;
  status: "draft" | "scheduled" | "sending" | "sent" | "paused";
  scheduled_at: string | null;
  sent_at: string | null;
  total_recipients: number;
  sent_count: number;
  open_count: number;
  click_count: number;
  reply_count: number;
  created_at: string;
  updated_at: string;
  parent_campaign_id?: string | null;
  follow_up_segment?: "all" | "opened" | "clicked" | null;
}

export type FollowUpSegment = "all" | "opened" | "clicked";

export interface ComposePrefill {
  emails: string[];
  parentId?: string;
  parentName?: string;
  segment?: FollowUpSegment;
}

export interface OutreachTemplate {
  id: string;
  name: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  created_at: string;
  updated_at: string;
  email_format?: string;
  track_opens?: boolean;
  track_clicks?: boolean;
  include_unsubscribe?: boolean;
  tracking_image_url?: string | null;
}

export interface OutreachReply {
  id: string;
  contact_id: string;
  campaign_id: string | null;
  direction: "inbound" | "outbound";
  subject: string | null;
  body: string | null;
  replied_at: string;
  created_at: string;
}

export interface SenderAccount {
  id: string;
  name: string;
  from_email: string;
  from_name: string;
  smtp_host: string;
  smtp_user: string;
  smtp_password: string;
  smtp_port: number;
  is_default: boolean;
  is_active?: boolean;
  group_id?: string | null;
}

export type OutreachSubPage =
  | "audiences"
  | "contacts"
  | "compose"
  | "templates"
  | "flows"
  | "sentlog"
  | "replies"
  | "mailbox"
  | "icp"
  | "performance";

export const STATUS_COLORS: Record<string, string> = {
  new: "bg-blue-100 text-blue-700",
  contacted: "bg-yellow-100 text-yellow-700",
  replied: "bg-green-100 text-green-700",
  interested: "bg-purple-100 text-purple-700",
  customer: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-700",
  unsubscribed: "bg-gray-100 text-gray-500",
};

function pickString(raw: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

function pickNum(raw: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = raw[k];
    const n = typeof v === "number" ? v : v != null ? parseFloat(String(v)) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Split a delimited list (categories, emails) that may arrive as an array or a
// comma / semicolon / pipe separated string.
function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) {
    return v
      .split(/[;,|]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Map one row of the general-business (Google Maps scrape) export to a contact.
 * Handles the med-spas CSV/JSON shape: name, categories, primary_category,
 * phone, website_url, domain, primary_email, emails, address, city, state,
 * postal_code, country_code, rating, review_count, maps_url, place_id, cid, ...
 */
export function mapImportedContact(raw: Record<string, unknown>): Partial<OutreachContact> {
  const emails = toList(raw.emails ?? raw.all_emails ?? raw.allEmails);
  const primaryEmail =
    pickString(raw, ["primary_email", "primaryEmail", "email", "Email", "EMAIL"]) || emails[0] || "";

  let name = pickString(raw, ["name", "business_name", "businessName", "Name", "title", "displayName"]);
  if (name && (name === name.toLowerCase() || name === name.toUpperCase())) name = titleCase(name);

  const categories = toList(raw.categories ?? raw.Categories);
  const primaryCategory =
    pickString(raw, ["primary_category", "primaryCategory", "category", "Category"]) ||
    categories[0] ||
    null;

  return {
    name: name || primaryEmail || "Unknown business",
    email: primaryEmail,
    all_emails: emails.length ? emails : primaryEmail ? [primaryEmail] : [],
    primary_category: primaryCategory,
    categories: categories.length ? categories : null,
    phone: pickString(raw, ["phone", "Phone", "phone_number", "telephone"]) || null,
    website_url:
      pickString(raw, ["website_url", "websiteUrl", "website", "Website", "url", "URL"]) || null,
    domain: pickString(raw, ["domain", "Domain"]) || null,
    address: pickString(raw, ["address", "Address", "full_address", "street_address", "streetAddress"]) || null,
    city: pickString(raw, ["city", "City", "locality", "town"]) || null,
    state: pickString(raw, ["state", "State", "region", "stateCode"]) || null,
    postal_code: pickString(raw, ["postal_code", "postalCode", "zip", "zipCode", "zip_code"]) || null,
    country_code: pickString(raw, ["country_code", "countryCode", "country"]) || null,
    latitude: pickNum(raw, ["latitude", "lat"]),
    longitude: pickNum(raw, ["longitude", "lng", "lon", "long"]),
    rating: pickNum(raw, ["rating", "Rating", "stars", "average_rating"]),
    review_count: pickNum(raw, ["review_count", "reviewCount", "reviews", "reviews_count", "user_ratings_total"]),
    maps_url: pickString(raw, ["maps_url", "mapsUrl", "google_maps_url", "gmaps_url"]) || null,
    place_id: pickString(raw, ["place_id", "placeId", "place_record_id"]) || null,
    cid: pickString(raw, ["cid", "CID"]) || null,
    source: pickString(raw, ["source"]) || "import",
    status: "new",
    // Keep the entire record so anything not curated above stays queryable.
    business_data: raw && typeof raw === "object" && Object.keys(raw).length ? raw : null,
  };
}

// Merge tags available in templates / compose (general-business profile).
export const MERGE_TAGS: { tag: string; label: string; sample: string }[] = [
  { tag: "{{business_name}}", label: "Business name", sample: "Glow Med Spa" },
  { tag: "{{name}}", label: "Business name (alias)", sample: "Glow Med Spa" },
  { tag: "{{category}}", label: "Primary category", sample: "Medical spa" },
  { tag: "{{city}}", label: "City", sample: "Austin" },
  { tag: "{{state}}", label: "State", sample: "TX" },
  { tag: "{{website}}", label: "Website", sample: "glowmedspa.com" },
  { tag: "{{phone}}", label: "Phone", sample: "(512) 555-0142" },
  { tag: "{{rating}}", label: "Google rating", sample: "4.8" },
  { tag: "{{review_count}}", label: "Review count", sample: "212" },
  { tag: "{{email}}", label: "Email", sample: "hello@glowmedspa.com" },
  { tag: "{{sender_name}}", label: "Your name", sample: "Alex" },
  { tag: "{{sender_email}}", label: "Your email", sample: "alex@rnq.agency" },
  { tag: "{{unsubscribe_url}}", label: "Unsubscribe link", sample: "https://.../u/..." },
];

// Field map used by preview + server-side send to substitute merge tags.
export function contactMergeValues(c: Partial<OutreachContact>): Record<string, string> {
  return {
    business_name: c.name || "",
    name: c.name || "",
    category: c.primary_category || (c.categories && c.categories[0]) || "",
    city: c.city || "",
    state: c.state || "",
    website: c.website_url || c.domain || "",
    phone: c.phone || "",
    rating: c.rating != null ? String(c.rating) : "",
    review_count: c.review_count != null ? String(c.review_count) : "",
    email: c.email || "",
  };
}
