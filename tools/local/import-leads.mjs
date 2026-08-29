// Lead importer — loads a scraped CSV into outreach_contacts with EVERY column
// preserved. Curated fields land in real columns; everything else is kept in the
// business_data jsonb, which is what powers the dynamic merge tags.
//
//   node tools/local/import-leads.mjs <csv> [--audience-by=state] [--source=name]
//                                    [--dry] [--max-context=2000]
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import Papa from "papaparse";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnv } from "./env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv(join(here, "..", ".."));

const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith("--"));
const flag = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : d; };
const DRY = args.includes("--dry");
const MAX_CONTEXT = Number(flag("max-context", 2000));
const SOURCE = flag("source", "import");
const AUDIENCE_BY = flag("audience-by", "state");
const AUDIENCE_PREFIX = flag("audience-prefix", "Med Spas");
if (!csvPath) { console.error("usage: node import-leads.mjs <csv> [--audience-by=state] [--dry]"); process.exit(1); }

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ── field helpers ───────────────────────────────────────────────────────────
const s = (v) => (v == null ? "" : String(v).trim());
const num = (v) => { const n = parseFloat(s(v)); return Number.isFinite(n) ? n : null; };
const int = (v) => { const n = parseInt(s(v), 10); return Number.isFinite(n) ? n : null; };
const bool = (v) => { const t = s(v).toLowerCase(); return t === "true" || t === "yes" || t === "1" ? true : t === "false" || t === "no" || t === "0" ? false : null; };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const listOf = (v) => {
  const raw = s(v);
  if (!raw) return [];
  if (raw.startsWith("[")) { try { const a = JSON.parse(raw); if (Array.isArray(a)) return a.map(s).filter(Boolean); } catch { /* fall through */ } }
  return raw.split(/[;|]|,(?![^(]*\))/).map(s).filter(Boolean);
};
const emailsOf = (r) =>
  [...new Set(`${s(r.primary_email)};${s(r.emails)}`.split(/[;,\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];
/** Prefer an address on the business's own domain when several exist. */
const pickEmail = (emails, domain) => {
  const d = s(domain).toLowerCase().replace(/^www\./, "");
  if (d) {
    const own = emails.find((e) => { const h = e.split("@")[1] || ""; return h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`); });
    if (own) return own;
  }
  return emails[0];
};

// Columns that already have a real home; everything else goes to business_data.
const CURATED = new Set([
  "name", "categories", "primary_category", "phone", "website_url", "domain",
  "primary_email", "emails", "address", "city", "state", "postal_code",
  "country_code", "latitude", "longitude", "rating", "review_count",
  "maps_url", "place_id", "cid",
]);

const rows = Papa.parse(readFileSync(csvPath, "utf8"), { header: true, skipEmptyLines: true }).data;
console.log(`parsed ${rows.length} rows from ${csvPath}`);

const seen = new Set();
const byAudience = new Map();
let noEmail = 0, dupe = 0;

for (const r of rows) {
  const emails = emailsOf(r);
  if (!emails.length) { noEmail++; continue; }
  const email = pickEmail(emails, r.domain);
  if (seen.has(email)) { dupe++; continue; }
  seen.add(email);

  // EVERY non-curated column is preserved verbatim (long prose is capped so the
  // free-tier database stays healthy — the cap is reported at the end).
  const extra = {};
  for (const [k, v] of Object.entries(r)) {
    const key = k.replace(/^﻿/, "").trim();
    if (!key || CURATED.has(key)) continue;
    const val = s(v);
    if (!val) continue;
    extra[key] = val.length > MAX_CONTEXT ? val.slice(0, MAX_CONTEXT) : val;
  }
  // Typed conveniences for the tag system.
  if (r.email_count != null) extra.email_count = int(r.email_count);
  if (r.context_available != null) { const b = bool(r.context_available); if (b !== null) extra.context_available = b; }
  extra.all_emails_count = emails.length;

  const categories = listOf(r.categories);
  const key = AUDIENCE_BY === "state" ? (s(r.state).toUpperCase() || "OTHER") : "ALL";
  if (!byAudience.has(key)) byAudience.set(key, []);
  byAudience.get(key).push({
    name: s(r.name) || email,
    email,
    all_emails: emails,
    primary_category: s(r.primary_category) || categories[0] || null,
    categories: categories.length ? categories : null,
    phone: s(r.phone) || null,
    website_url: s(r.website_url) || null,
    domain: s(r.domain) || null,
    address: s(r.address) || null,
    city: s(r.city) || null,
    state: s(r.state) || null,
    postal_code: s(r.postal_code) || null,
    country_code: s(r.country_code) || null,
    latitude: num(r.latitude),
    longitude: num(r.longitude),
    rating: num(r.rating),
    review_count: int(r.review_count),
    maps_url: s(r.maps_url) || null,
    place_id: s(r.place_id) || null,
    cid: s(r.cid) || null,
    source: SOURCE,
    business_data: extra,
  });
}

const total = [...byAudience.values()].reduce((a, b) => a + b.length, 0);
const allKeys = new Set();
for (const list of byAudience.values()) for (const c of list) for (const k of Object.keys(c.business_data)) allKeys.add(k);
console.log(`\n${total} unique contacts · skipped ${noEmail} without an email, ${dupe} duplicates`);
console.log(`business_data keys captured (${allKeys.size}): ${[...allKeys].sort().join(", ")}`);
console.log(`audiences (${byAudience.size}): ${[...byAudience.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => `${k}:${v.length}`).join("  ")}`);
if (DRY) { console.log("\n--dry: nothing written."); process.exit(0); }

// ── audiences ───────────────────────────────────────────────────────────────
const { data: existing } = await sb.from("outreach_audiences").select("id,name");
const nameToId = new Map((existing || []).map((a) => [a.name, a.id]));
const PALETTE = ["#ff0048", "#e11d48", "#f59e0b", "#10b981", "#3b82f6", "#6366f1", "#a855f7", "#ec4899", "#14b8a6", "#f97316"];
let ci = 0;
for (const key of byAudience.keys()) {
  const label = AUDIENCE_BY === "state" ? `${AUDIENCE_PREFIX} — ${key}` : AUDIENCE_PREFIX;
  if (nameToId.has(label)) continue;
  const { data } = await sb.from("outreach_audiences")
    .insert({ name: label, description: `${byAudience.get(key).length} leads`, color: PALETTE[ci++ % PALETTE.length] })
    .select().single();
  if (data) nameToId.set(label, data.id);
}

// ── upsert contacts (existing rows get their full field set filled in) ──────
let written = 0, failed = 0;
for (const [key, list] of byAudience) {
  const label = AUDIENCE_BY === "state" ? `${AUDIENCE_PREFIX} — ${key}` : AUDIENCE_PREFIX;
  const audienceId = nameToId.get(label) || null;
  const payload = list.map((c) => ({ ...c, audience_id: audienceId }));
  for (let i = 0; i < payload.length; i += 400) {
    const chunk = payload.slice(i, i + 400);
    const { error } = await sb.from("outreach_contacts")
      .upsert(chunk, { onConflict: "email", ignoreDuplicates: false });
    if (error) { console.error(`  ${key} chunk ${i}: ${error.message}`); failed += chunk.length; }
    else written += chunk.length;
  }
  process.stdout.write(`  ${label}: ${list.length}\n`);
}
console.log(`\nupserted ${written} contacts${failed ? `, ${failed} failed` : ""}.`);
