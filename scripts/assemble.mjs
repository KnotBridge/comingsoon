// Assemble the Netlify publish directory: copy the static R'NQ marketing site
// (repo root) into publish/, alongside the already-built admin SPA (Vite wrote
// it to publish/admin). Run after `vite build`.
import { cpSync, mkdirSync, existsSync, readdirSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";

const root = process.cwd();
const publish = join(root, "publish");
mkdirSync(publish, { recursive: true });

// Directories/files at the repo root that are NOT part of the static site.
const SKIP = new Set([
  "publish", "admin", "netlify", "scripts", "node_modules", "supabase",
  ".git", ".github", ".netlify",
  "package.json", "package-lock.json", "bun.lock", "netlify.toml",
  ".gitignore", "DEPLOY-SECRETS.txt", "README.md",
]);

let copied = 0;
for (const name of readdirSync(root)) {
  if (SKIP.has(name)) continue;
  if (name.startsWith(".")) continue;
  const src = join(root, name);
  // Only copy the site's own assets (html/css/img/fonts/audio), not stray dirs.
  cpSync(src, join(publish, name), { recursive: true });
  copied++;
}
console.log(`assemble: copied ${copied} root entries into publish/`);

// Ship the Netlify config + redirects with the dropped folder.
if (existsSync(join(root, "netlify.toml"))) {
  copyFileSync(join(root, "netlify.toml"), join(publish, "netlify.toml"));
}
writeFileSync(
  join(publish, "_redirects"),
  [
    "/api/*        /.netlify/functions/:splat   200",
    "/t/o          /.netlify/functions/track-open   200",
    "/t/c          /.netlify/functions/track-click  200",
    "/unsubscribe  /.netlify/functions/unsubscribe  200",
    "/admin/*      /admin/index.html            200",
    "",
  ].join("\n")
);

if (!existsSync(join(publish, "admin", "index.html"))) {
  console.warn("assemble: WARNING publish/admin/index.html missing (vite build did not run?)");
}
if (!existsSync(join(publish, "netlify", "functions"))) {
  console.warn("assemble: WARNING publish/netlify/functions missing (bundle step did not run?)");
}
console.log("assemble: wrote _redirects + netlify.toml into publish/");
