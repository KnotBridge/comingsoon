// Proves the PSD engine end to end without needing a hand-made file:
// builds a fixture PSD (background + two placeholder text layers, like the
// two-coffee-cups mockup), scans it, then renders it with real names.
import { writePsd } from "ag-psd";
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
// Importing the engine also installs the canvas adapter into ag-psd.
import { scanPsd, renderPsd } from "./psd-engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const W = 900, H = 500;

const textLayer = (name, str, x, y, size, rgb) => {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.font = `bold ${size}px Arial`;
  ctx.fillStyle = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(str, x, y);
  return {
    name,
    left: 0, top: 0, right: W, bottom: H,
    canvas: c,
    text: {
      text: str,
      style: { font: { name: "Arial-Bold" }, fontSize: size, fillColor: rgb },
      paragraphStyle: { justification: "center" },
    },
  };
};
const BROWN = { r: 138, g: 90, b: 43 };

// Background: a mug-ish scene so we can see the composite survives.
const bg = createCanvas(W, H);
{
  const ctx = bg.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#f4ece2"); g.addColorStop(1, "#dcc9b4");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  for (const cx of [250, 650]) {
    ctx.beginPath(); ctx.ellipse(cx, 250, 150, 170, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = "#c9b49c"; ctx.lineWidth = 6;
  for (const cx of [250, 650]) {
    ctx.beginPath(); ctx.ellipse(cx, 250, 150, 170, 0, 0, Math.PI * 2); ctx.stroke();
  }
}

const psd = {
  width: W, height: H,
  children: [
    { name: "Background", left: 0, top: 0, right: W, bottom: H, canvas: bg },
    textLayer("sender name", "{{sender_first_name}}", 250, 265, 44, BROWN),
    textLayer("their name", "{{business_name}}", 650, 265, 40, BROWN),
  ],
};

const psdBuffer = Buffer.from(writePsd(psd, { generateThumbnail: false }));
const fixture = join(here, "fixture-cups.psd");
writeFileSync(fixture, psdBuffer);
console.log(`fixture PSD written: ${fixture} (${(psdBuffer.length / 1024).toFixed(0)} KB)`);

// 1) SCAN
const scan = scanPsd(psdBuffer);
console.log(`\nSCAN -> ${scan.width}x${scan.height}, ${scan.textLayerCount} editable text layers:`);
for (const l of scan.layers) {
  console.log(`  [${l.id}] "${l.name}" text=${JSON.stringify(l.sampleText)} tag=${l.suggestedTag} font=${l.font}@${l.fontSize} ${l.color} align=${l.align}`);
}

// 2) RENDER with real values, mapped by the tag each layer already carries
const merge = { sender_first_name: "Justin", business_name: "Glow Med Spa" };
const values = {};
for (const l of scan.layers) if (l.suggestedTag) values[l.id] = merge[l.suggestedTag] ?? "";
const png = renderPsd(psdBuffer, values);
const outPng = join(here, "render-out.png");
writeFileSync(outPng, png);
console.log(`\nRENDER -> ${outPng} (${(png.length / 1024).toFixed(0)} KB)`);

// 3) A long name must shrink to fit rather than overflow the artwork
const png2 = renderPsd(psdBuffer, (() => {
  const v = {};
  const m = { sender_first_name: "Justin", business_name: "Radiance Aesthetics & Laser Center" };
  for (const l of scan.layers) if (l.suggestedTag) v[l.id] = m[l.suggestedTag] ?? "";
  return v;
})());
writeFileSync(join(here, "render-long.png"), png2);
console.log(`RENDER (long name) -> render-long.png (${(png2.length / 1024).toFixed(0)} KB)`);
console.log("\nOK");
