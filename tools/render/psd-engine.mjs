// PSD -> personalized PNG engine (runs locally, never on a server).
//
// Two jobs:
//   scanPsd(buffer)            -> the editable text layers found in a PSD
//   renderPsd(buffer, values)  -> a PNG with those layers replaced per recipient
//
// How the replacement stays visually faithful: instead of re-implementing
// Photoshop's text engine, we measure the INK BOUNDS of the original rendered
// text layer (the pixels Photoshop already drew) and place the new string in
// exactly that spot, at the same size/colour/alignment. A name swapped onto a
// coffee cup therefore lands where the original name sat.
import { readPsd, initializeCanvas } from "ag-psd";
import { createCanvas, GlobalFonts, ImageData } from "@napi-rs/canvas";

// ag-psd (v31) wants exactly two adapters in Node: make a canvas, and make raw
// ImageData. Without the second, reading layer pixels throws.
initializeCanvas(
  (width, height) => createCanvas(width, height),
  (width, height) => new ImageData(width, height)
);

let fontsReady = false;
/** Load system fonts once, plus any .ttf/.otf dropped in tools/render/fonts. */
export function ensureFonts(extraDir) {
  if (fontsReady) return;
  try { GlobalFonts.loadSystemFonts(); } catch { /* non-fatal */ }
  if (extraDir) { try { GlobalFonts.loadFontsFromDir(extraDir); } catch { /* optional */ } }
  fontsReady = true;
}

const isTextLayer = (l) => !!(l && l.text && typeof l.text.text === "string");

/** Depth-first walk of the layer tree, bottom layer first (PSD storage order). */
function walk(node, out = [], path = []) {
  for (const layer of node.children || []) {
    const here = [...path, layer.name || ""];
    if (layer.children?.length) walk(layer, out, here);
    else out.push({ layer, path: here });
  }
  return out;
}

/** Stable id for a layer so the UI mapping survives re-uploads of the same PSD. */
const layerId = (entry, i) => `${i}:${entry.path.join("/")}`;

function colorOf(text) {
  const c = text?.style?.fillColor;
  if (!c) return "#000000";
  const to = (v) => Math.max(0, Math.min(255, Math.round(v ?? 0)));
  return `rgb(${to(c.r)}, ${to(c.g)}, ${to(c.b)})`;
}

function fontOf(text) {
  const name = text?.style?.font?.name || "Arial";
  // Photoshop names look like "Montserrat-SemiBold" / "Helvetica-Bold".
  const [family, variant = ""] = name.split("-");
  const v = variant.toLowerCase();
  return {
    family: family.replace(/([a-z])([A-Z])/g, "$1 $2"),
    weight: /bold|black|heavy|semibold|demi/.test(v) ? "bold" : "normal",
    style: /italic|oblique/.test(v) ? "italic" : "normal",
    size: Math.round(text?.style?.fontSize || 24),
    raw: name,
  };
}

const JUSTIFY = { left: "left", center: "center", right: "right" };
const justifyOf = (text) =>
  JUSTIFY[text?.paragraphStyle?.justification] || JUSTIFY[text?.style?.justification] || "left";

/**
 * List every text layer in the PSD, with the placeholder tag it already carries
 * (a layer whose text is "{{first_name}}" is auto-mapped for you).
 */
export function scanPsd(buffer) {
  const psd = readPsd(buffer, { skipCompositeImageData: true, skipThumbnail: true, useImageData: false });
  const entries = walk(psd);
  const layers = [];
  entries.forEach((e, i) => {
    if (!isTextLayer(e.layer)) return;
    const t = e.layer.text;
    const f = fontOf(t);
    const raw = (t.text || "").replace(/\r/g, "\n").trim();
    const tagMatch = raw.match(/\{\{\s*([a-z0-9_]+)\s*\}\}/i);
    layers.push({
      id: layerId(e, i),
      name: e.layer.name || `Text ${i}`,
      path: e.path.join(" / "),
      sampleText: raw,
      suggestedTag: tagMatch ? tagMatch[1].toLowerCase() : null,
      font: f.raw,
      fontSize: f.size,
      color: colorOf(t),
      align: justifyOf(t),
    });
  });
  return { width: psd.width, height: psd.height, textLayerCount: layers.length, layers };
}

/** Bounding box of non-transparent pixels — where Photoshop actually drew the text. */
function inkBounds(canvas) {
  const { width: w, height: h } = canvas;
  if (!w || !h) return null;
  const data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/**
 * Render the PSD with text layers replaced.
 * @param buffer  raw .psd bytes
 * @param values  { [layerId]: "text to draw" } — layers not present keep their original art
 * @returns PNG Buffer
 */
export function renderPsd(buffer, values = {}, opts = {}) {
  ensureFonts(opts.fontDir);
  const psd = readPsd(buffer, { skipThumbnail: true });
  const out = createCanvas(psd.width, psd.height);
  const ctx = out.getContext("2d");
  const entries = walk(psd);

  entries.forEach((e, i) => {
    const layer = e.layer;
    if (layer.hidden) return;
    const id = layerId(e, i);
    const replacement = Object.prototype.hasOwnProperty.call(values, id) ? String(values[id] ?? "") : null;
    const canvas = layer.canvas;
    const alpha = layer.opacity == null ? 1 : layer.opacity;

    // Untouched layer: paint the art Photoshop already produced.
    if (replacement === null || !isTextLayer(layer)) {
      if (canvas) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(canvas, layer.left || 0, layer.top || 0);
        ctx.restore();
      }
      return;
    }

    // Replaced text layer: drop the original pixels, draw the new string in their place.
    if (!replacement.trim()) return; // empty value => layer simply disappears
    const t = layer.text;
    const f = fontOf(t);
    const ink = canvas ? inkBounds(canvas) : null;
    const boxLeft = (layer.left || 0) + (ink ? ink.minX : 0);
    const boxRight = (layer.left || 0) + (ink ? ink.maxX : (layer.right || 0) - (layer.left || 0));
    const boxTop = (layer.top || 0) + (ink ? ink.minY : 0);
    const boxBottom = (layer.top || 0) + (ink ? ink.maxY : (layer.bottom || 0) - (layer.top || 0));

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colorOf(t);
    const align = justifyOf(t);
    let size = f.size;
    const setFont = (px) => { ctx.font = `${f.style} ${f.weight} ${px}px "${f.family}", Arial, sans-serif`; };
    setFont(size);

    // Never let a longer name overflow the artwork: shrink to fit the original width.
    const targetW = Math.max(1, boxRight - boxLeft);
    if (ink) {
      let m = ctx.measureText(replacement);
      let guard = 0;
      while (m.width > targetW && size > 6 && guard++ < 80) {
        size -= 1;
        setFont(size);
        m = ctx.measureText(replacement);
      }
    }

    const m = ctx.measureText(replacement);
    const ascent = m.actualBoundingBoxAscent || size * 0.75;
    const descent = m.actualBoundingBoxDescent || size * 0.25;
    // Sit the new text on the same optical centre line as the old text.
    const centreY = ink ? (boxTop + boxBottom) / 2 : (layer.top || 0) + size / 2;
    const baseline = centreY + (ascent - descent) / 2;

    ctx.textBaseline = "alphabetic";
    ctx.textAlign = align;
    const x = align === "center" ? (boxLeft + boxRight) / 2 : align === "right" ? boxRight : boxLeft;
    ctx.fillText(replacement, x, baseline);
    ctx.restore();
  });

  return out.toBuffer("image/png");
}

/** Values keyed by layer id, resolved from a {layerId -> tag} mapping + merge values. */
export function valuesForMapping(mapping, mergeValues) {
  const out = {};
  for (const [lid, tag] of Object.entries(mapping || {})) {
    if (!tag) continue;
    out[lid] = mergeValues?.[tag] ?? "";
  }
  return out;
}
