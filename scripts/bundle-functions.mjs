// Bundle each Netlify function into a single self-contained ESM file so the
// drag-and-drop deploy carries no node_modules. Node built-ins stay external.
import { build } from "esbuild";
import { readdirSync, mkdirSync } from "fs";
import { join } from "path";

const SRC = "netlify/functions";
const OUT = "publish/netlify/functions";
mkdirSync(OUT, { recursive: true });

const entries = readdirSync(SRC).filter((f) => f.endsWith(".mjs"));
await build({
  entryPoints: entries.map((f) => join(SRC, f)),
  outdir: OUT,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Netlify's runtime provides these; keep imapflow/nodemailer/supabase bundled in.
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
console.log(`bundled ${entries.length} functions -> ${OUT}`);
