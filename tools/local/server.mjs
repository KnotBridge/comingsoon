// R'NQ local mailer.
//
// Runs the whole backend on your machine:
//   • every Netlify function mounted at /api/<name>  (so the dashboard works locally)
//   • PSD upload / scan / preview endpoints
//   • a render loop that turns queued "needs art" emails into personalised PNGs
//   • optionally the flow + queue + IMAP workers on a timer (LOCAL_WORKERS=1)
//
//   npm run local        (from the R'NQ folder)
import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { scanPsd, renderPsd, ensureFonts, ENGINE_VERSION } from "../render/psd-engine.mjs";
import { loadEnv } from "./env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
loadEnv(ROOT);

const PORT = Number(process.env.LOCAL_PORT || 8787);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (put them in .env.local).");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

ensureFonts(join(here, "..", "render", "fonts"));

const app = express();
app.use(express.json({ limit: "25mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// ── Mount the Netlify functions so the local UI can call /api/* ─────────────
const FN_DIR = join(ROOT, "netlify", "functions");
const fnCache = new Map();
async function loadFn(name) {
  if (!fnCache.has(name)) {
    const file = join(FN_DIR, `${name}.mjs`);
    if (!existsSync(file)) return null;
    const mod = await import(pathToFileURL(file).href);
    fnCache.set(name, mod.default);
  }
  return fnCache.get(name);
}

app.all("/api/:name", async (req, res, next) => {
  const name = req.params.name;
  // Image endpoints are handled below, not by a Netlify function.
  if (name.startsWith("image-")) return next();
  try {
    const fn = await loadFn(name);
    if (!fn) return res.status(404).json({ error: `no local function "${name}"` });
    const url = `http://localhost:${PORT}${req.originalUrl}`;
    const init = { method: req.method, headers: req.headers };
    if (!["GET", "HEAD"].includes(req.method)) init.body = JSON.stringify(req.body ?? {});
    const out = await fn(new Request(url, init));
    res.status(out.status);
    out.headers.forEach((v, k) => { if (k !== "content-encoding") res.setHeader(k, v); });
    res.send(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    console.error(`[api/${name}]`, e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ── PSD: upload + scan ──────────────────────────────────────────────────────
app.post("/api/image-templates/scan", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const name = req.body?.name || req.file.originalname?.replace(/\.psd$/i, "") || "Untitled";
    const buf = req.file.buffer;

    let scan;
    try { scan = scanPsd(buf); }
    catch (e) { return res.status(400).json({ error: `Could not read that PSD: ${e.message}` }); }
    if (!scan.textLayerCount) {
      return res.status(400).json({ error: "No editable text layers found. Keep the placeholder text as real Photoshop text layers (not rasterised)." });
    }

    const path = `psd/${Date.now()}-${(req.file.originalname || "template.psd").replace(/[^a-z0-9.\-_]/gi, "_")}`;
    const up = await sb.storage.from("image-templates").upload(path, buf, { contentType: "image/vnd.adobe.photoshop", upsert: true });
    if (up.error) return res.status(500).json({ error: `upload failed: ${up.error.message}` });

    // Auto-map any layer whose text already contains a {{tag}}.
    const mapping = {};
    for (const l of scan.layers) if (l.suggestedTag) mapping[l.id] = l.suggestedTag;

    const { data, error } = await sb.from("image_templates").insert({
      name, storage_path: path, file_kind: "psd",
      width: scan.width, height: scan.height,
      layers: scan.layers, mapping,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) {
    console.error("[scan]", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ── PSD: preview render with sample values ──────────────────────────────────
app.post("/api/image-templates/preview", async (req, res) => {
  try {
    const { id, values } = req.body || {};
    const tpl = await getTemplate(id);
    if (!tpl) return res.status(404).json({ error: "template not found" });
    const url = await renderAndStore(tpl, values || {}, "preview");
    await sb.from("image_templates").update({ preview_url: url }).eq("id", id);
    res.json({ url });
  } catch (e) {
    console.error("[preview]", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/image-templates/health", (_req, res) => res.json({ ok: true, renderer: "psd", port: PORT }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── Rendering ───────────────────────────────────────────────────────────────
const psdCache = new Map();
async function getTemplate(id) {
  const { data } = await sb.from("image_templates").select("*").eq("id", id).maybeSingle();
  return data || null;
}
async function getPsdBuffer(tpl) {
  if (psdCache.has(tpl.id)) return psdCache.get(tpl.id);
  const { data, error } = await sb.storage.from("image-templates").download(tpl.storage_path);
  if (error) throw new Error(`download failed: ${error.message}`);
  const buf = Buffer.from(await data.arrayBuffer());
  psdCache.set(tpl.id, buf);
  return buf;
}

const hashOf = (o) => createHash("sha1").update(JSON.stringify(o)).digest("hex").slice(0, 24);

/** Render values -> PNG -> public URL, reusing an identical earlier render. */
async function renderAndStore(tpl, values, tag = "r") {
  // Version the key so a renderer improvement never serves stale artwork.
  const key = hashOf({ v: ENGINE_VERSION, values });
  const { data: hit } = await sb.from("image_renders")
    .select("url").eq("image_template_id", tpl.id).eq("value_hash", key).maybeSingle();
  if (hit?.url) return hit.url;

  const png = renderPsd(await getPsdBuffer(tpl), values, { fontDir: join(here, "..", "render", "fonts") });
  const path = `${tpl.id}/${tag}-${key}.png`;
  const up = await sb.storage.from("renders").upload(path, png, { contentType: "image/png", upsert: true });
  if (up.error) throw new Error(`render upload failed: ${up.error.message}`);
  const { data: pub } = sb.storage.from("renders").getPublicUrl(path);
  const url = pub.publicUrl;
  await sb.from("image_renders").insert({ image_template_id: tpl.id, value_hash: key, url });
  return url;
}

/**
 * Turn queued "needs art" emails into real ones: draw the PNG, swap the
 * {{dynamic_image}} placeholder for it, then release the row to the sender.
 */
async function processRenderQueue() {
  const { data: rows } = await sb.from("email_queue")
    .select("id, render_spec")
    .eq("render_status", "pending").limit(25);
  if (!rows?.length) return 0;

  let done = 0;
  for (const row of rows) {
    try {
      const spec = row.render_spec || {};
      const tpl = await getTemplate(spec.imageTemplateId);
      if (!tpl) throw new Error("image template missing");
      const url = await renderAndStore(tpl, spec.values || {});
      // Only record the URL. The send worker places the picture at the
      // {{tracked_image}} tag, so plain-text emails keep their exact spacing and
      // the width control ({{tracked_image:320}}) still applies — the same
      // behaviour as an image you upload yourself.
      await sb.from("email_queue").update({ render_url: url, render_status: "done" }).eq("id", row.id);
      done++;
    } catch (e) {
      console.error(`[render ${row.id}]`, e.message);
      await sb.from("email_queue").update({
        render_status: "failed", error_message: `render: ${String(e.message).slice(0, 200)}`,
      }).eq("id", row.id);
    }
  }
  if (done) {
    console.log(`[render] personalised ${done} image(s) — releasing to the sender`);
    // The row was skipped by the send worker while it had no art. Now it has
    // art, so drain immediately instead of leaving it to sit as "pending".
    try {
      const fn = await loadFn("process-email-queue");
      if (fn) {
        const r = await fn(new Request(`http://localhost:${PORT}/api/process-email-queue`, {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        }));
        console.log("[render] send ->", await r.text());
      }
    } catch (e) { console.error("[render] send kick failed:", e.message); }
  }
  return done;
}

// ── Timers ──────────────────────────────────────────────────────────────────
const RENDER_MS = Number(process.env.RENDER_INTERVAL_MS || 5000);
setInterval(() => { processRenderQueue().catch((e) => console.error("[render loop]", e.message)); }, RENDER_MS);

// Always keep the send queue moving while the local mailer is up — pressing
// Send in the dashboard should never leave an email sitting in "pending".
const drain = async () => {
  try {
    const fn = await loadFn("process-email-queue");
    if (!fn) return;
    const r = await fn(new Request(`http://localhost:${PORT}/api/process-email-queue`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    const txt = await r.text();
    if (!/"processed":0/.test(txt)) console.log("[queue]", txt);
  } catch (e) { console.error("[queue]", e.message); }
};
setInterval(drain, 30_000);

if (process.env.LOCAL_WORKERS === "1") {
  const tick = async (name, body) => {
    try {
      const fn = await loadFn(name);
      if (!fn) return;
      const r = await fn(new Request(`http://localhost:${PORT}/api/${name}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
      }));
      const txt = await r.text();
      if (!/"(processed|advanced|enrolled)":0/.test(txt) || txt.includes('"sent":')) console.log(`[${name}]`, txt);
    } catch (e) { console.error(`[${name}]`, e.message); }
  };
  setInterval(() => tick("process-email-flows"), 60_000);
  setInterval(() => tick("fetch-imap-replies"), 5 * 60_000);
  console.log("local workers ON — flows every 60s, IMAP every 5 min (queue drains every 30s regardless)");
}

app.listen(PORT, () => {
  console.log(`\n  R'NQ local mailer  →  http://localhost:${PORT}`);
  console.log(`  PSD renderer ready · render loop every ${RENDER_MS / 1000}s`);
  console.log(`  Netlify functions mounted at /api/*  (${readdirSync(FN_DIR).filter((f) => f.endsWith(".mjs")).length} found)`);
  console.log(`  Workers: ${process.env.LOCAL_WORKERS === "1" ? "ON" : "off (set LOCAL_WORKERS=1 to run flows/queue locally)"}\n`);
});
