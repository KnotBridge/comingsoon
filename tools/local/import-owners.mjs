// One-off importer for a PERSON-level list (owner/decision-maker names).
// Reads the PowerShell-exported JSON and upserts contacts where the contact's
// NAME is the person and the company lives in business_data — so {{first_name}}
// is the owner's real first name and {{business_name}} is the company.
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnv } from "./env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv(join(here, "..", ".."));
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const AUDIENCE = process.argv[3] || "Owners — 400";
const src = JSON.parse(readFileSync(process.argv[2], "utf8").replace(/^﻿/, "").trim());
const rows = Array.isArray(src) ? src : [src];
console.log(`source rows: ${rows.length}`);

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// "Austin, TX, United States" -> city + 2-letter state
const splitLoc = (loc) => {
  const parts = String(loc || "").split(",").map((s) => s.trim()).filter(Boolean);
  let city = "", state = "";
  if (parts.length >= 2) { city = parts[0]; const m = parts[1].match(/\b([A-Z]{2})\b/); state = m ? m[1] : parts[1]; }
  else if (parts.length === 1) city = parts[0];
  return { city, state };
};

const seen = new Set();
const contacts = [];
for (const r of rows) {
  const email = String(r.email || "").toLowerCase().trim();
  if (!EMAIL.test(email) || seen.has(email)) continue;
  seen.add(email);
  const first = (r.first_name || "").trim();
  const last = (r.last_name || "").trim();
  const person = [first, last].filter(Boolean).join(" ") || email;
  const { city, state } = splitLoc(r.location);
  contacts.push({
    name: person,                    // the PERSON — so first_name = owner's name
    email,
    website_url: r.website || null,
    city: city || null,
    state: state || null,
    source: "owners-400",
    business_data: {
      first_name: first,
      last_name: last,
      company_name: (r.company || "").trim(),
      job_title: (r.job_title || "").trim(),
      job_level: (r.job_level || "").trim(),
      industry: (r.industry || "").trim(),
      sub_industry: (r.sub_industry || "").trim(),
      linkedin: (r.linkedin || "").trim(),
      location: (r.location || "").trim(),
      headline: (r.headline || "").trim(),
      phone: (r.phone || "").trim(),
    },
  });
}
console.log(`unique valid contacts: ${contacts.length}`);

// audience
const { data: existing } = await sb.from("outreach_audiences").select("id,name").eq("name", AUDIENCE).maybeSingle();
let audienceId = existing?.id;
if (!audienceId) {
  const { data } = await sb.from("outreach_audiences")
    .insert({ name: AUDIENCE, description: `${contacts.length} decision-makers`, color: "#6366f1" }).select().single();
  audienceId = data.id;
  console.log(`created audience "${AUDIENCE}"`);
} else console.log(`audience "${AUDIENCE}" exists`);

let written = 0, failed = 0;
for (let i = 0; i < contacts.length; i += 300) {
  const chunk = contacts.slice(i, i + 300).map((c) => ({ ...c, audience_id: audienceId }));
  const { error } = await sb.from("outreach_contacts").upsert(chunk, { onConflict: "email", ignoreDuplicates: false });
  if (error) { console.error(`  chunk ${i}: ${error.message}`); failed += chunk.length; }
  else written += chunk.length;
}
console.log(`upserted ${written} contacts${failed ? `, ${failed} failed` : ""}`);
// sample check
const { data: sample } = await sb.from("outreach_contacts").select("name,email,business_data").eq("audience_id", audienceId).limit(2);
for (const s of sample || []) console.log(`  ${s.name} <${s.email}>  company=${s.business_data?.company_name}  title=${s.business_data?.job_title}`);
