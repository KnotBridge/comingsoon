// Theme defaults for visual email authoring. A theme supplies the initial typography,
// paragraph rhythm, and line measure. User formatting remains independent and is
// preserved as inline overrides when the message is saved and reopened.

export interface EmailTheme {
  key: string;
  name: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
  paragraphGap: number;
  maxWidth: number | null;
}

export const EMAIL_THEMES: EmailTheme[] = [
  { key: "kingkong", name: "King Kong", fontFamily: "Helvetica, Arial, sans-serif", fontSize: 20, lineHeight: 28, color: "#000000", paragraphGap: 24, maxWidth: 620 },
  { key: "clean", name: "Clean", fontFamily: "Arial, Helvetica, sans-serif", fontSize: 15, lineHeight: 24, color: "#111111", paragraphGap: 16, maxWidth: 600 },
  { key: "compact", name: "Compact", fontFamily: "-apple-system, 'Segoe UI', Roboto, Arial, sans-serif", fontSize: 15, lineHeight: 22, color: "#1a1a1a", paragraphGap: 12, maxWidth: 600 },
  { key: "serif", name: "Serif", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 18, lineHeight: 27, color: "#1a1a1a", paragraphGap: 20, maxWidth: 600 },
  // No theme deliberately emits no base font, size, color, or width. Formatting that the
  // writer applies manually is still stored inline because that is how mail clients keep it.
  { key: "none", name: "No theme", fontFamily: "Arial, Helvetica, sans-serif", fontSize: 16, lineHeight: 24, color: "#1a1a1a", paragraphGap: 0, maxWidth: null },
];

export const themeByKey = (key: string): EmailTheme => EMAIL_THEMES.find((t) => t.key === key) || EMAIL_THEMES[0];

export const FONT_CHOICES: { label: string; value: string }[] = [
  { label: "Helvetica", value: "Helvetica, Arial, sans-serif" },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Georgia", value: "Georgia, 'Times New Roman', serif" },
  { label: "Times", value: "'Times New Roman', Times, serif" },
  { label: "Courier", value: "'Courier New', Courier, monospace" },
  { label: "System", value: "-apple-system, 'Segoe UI', Roboto, Arial, sans-serif" },
];

export const SIZE_CHOICES = [11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 36];
export const LINEHEIGHT_CHOICES = [
  { label: "1.0", value: 1 },
  { label: "1.2", value: 1.2 },
  { label: "1.35", value: 1.35 },
  { label: "1.5", value: 1.5 },
  { label: "1.7", value: 1.7 },
  { label: "2.0", value: 2 },
];
export const PARAGRAPH_GAP_CHOICES = [0, 4, 8, 12, 16, 20, 24, 32, 40];

// Link placeholders are already complete destinations. Prefixing one with https://
// creates values such as https://https://renov.space/r/... after tag substitution.
export function normalizeEmailLinkInput(input: string): string {
  const value = input.trim();
  if (!value) return "";
  const placeholder = /^(?:https?:\/\/)?\{\{\s*([a-z0-9_]+)\s*\}\}$/i.exec(value);
  if (placeholder) return `{{${placeholder[1]}}}`;
  if (/^(?:https?:\/\/|mailto:|tel:|#|\/)/i.test(value)) return value;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return `mailto:${value}`;
  return `https://${value}`;
}

export function repairDuplicateUrlProtocols(value: string): string {
  return value.replace(/(?:https?:\/\/)+(?=https?:\/\/)/gi, "");
}

export function containerStyle(t: EmailTheme): string {
  if (t.key === "none") return "";
  const width = t.maxWidth == null ? "" : `max-width:${t.maxWidth}px;`;
  return `${width}font-family:${t.fontFamily};font-size:${t.fontSize}px;line-height:${t.lineHeight}px;color:${t.color};`;
}

export function paragraphStyle(t: EmailTheme): string {
  if (t.key === "none") return `margin:0 0 ${t.paragraphGap}px 0;`;
  return `margin:0 0 ${t.paragraphGap}px 0;font-family:${t.fontFamily};font-size:${t.fontSize}px;line-height:${t.lineHeight}px;color:${t.color};`;
}

function copyAttributes(from: HTMLElement, to: HTMLElement) {
  Array.from(from.attributes).forEach((attr) => to.setAttribute(attr.name, attr.value));
}

function isBlankBlock(el: HTMLElement): boolean {
  const text = (el.textContent || "").replace(/\u00a0/g, "").trim();
  return !text && !/<(img|hr|table)/i.test(el.innerHTML);
}

function normalizeCss(value: string): string {
  return (value || "").toLowerCase().replace(/[\s'"]/g, "");
}

function normalizeColor(value: string): string {
  const v = normalizeCss(value);
  if (/^#[0-9a-f]{6}$/.test(v)) {
    const r = Number.parseInt(v.slice(1, 3), 16);
    const g = Number.parseInt(v.slice(3, 5), 16);
    const b = Number.parseInt(v.slice(5, 7), 16);
    return `rgb(${r},${g},${b})`;
  }
  return v;
}

function sameCss(a: string, b: string, color = false): boolean {
  return color ? normalizeColor(a) === normalizeColor(b) : normalizeCss(a) === normalizeCss(b);
}

// Stored email blocks contain fully inlined theme styles for mail-client compatibility.
// The editor removes only those generated defaults on load. Real user overrides remain,
// so a later theme change cannot erase a smaller signature, custom color, or custom gap.
function prepareBlockForEditor(block: HTMLElement, storedTheme: EmailTheme) {
  const blank = isBlankBlock(block);
  const style = block.style;
  const originalGap = style.marginBottom;
  const originalLineHeight = style.lineHeight;

  const explicitGap = block.getAttribute("data-email-gap");
  const generatedBlankGap = blank && !explicitGap && sameCss(originalGap, "0px");
  style.removeProperty("margin");
  if (explicitGap != null) {
    style.marginBottom = `${Number(explicitGap)}px`;
  } else if (originalGap && !generatedBlankGap && !sameCss(originalGap, `${storedTheme.paragraphGap}px`)) {
    style.marginBottom = originalGap;
    block.setAttribute("data-email-gap", String(Number.parseFloat(originalGap)));
  }

  const explicitLineHeight = block.getAttribute("data-email-line-height");
  style.removeProperty("line-height");
  if (explicitLineHeight != null) {
    style.lineHeight = explicitLineHeight;
  } else if (originalLineHeight && !sameCss(originalLineHeight, `${storedTheme.lineHeight}px`)) {
    style.lineHeight = originalLineHeight;
    block.setAttribute("data-email-line-height", originalLineHeight);
  }

  if (style.fontFamily && sameCss(style.fontFamily, storedTheme.fontFamily)) style.removeProperty("font-family");
  if (style.fontSize && sameCss(style.fontSize, `${storedTheme.fontSize}px`)) style.removeProperty("font-size");
  if (style.color && sameCss(style.color, storedTheme.color, true)) style.removeProperty("color");

  if (blank) {
    block.innerHTML = "<br>";
    block.setAttribute("data-empty-line", "true");
  } else {
    block.removeAttribute("data-empty-line");
  }

  if (!style.cssText) block.removeAttribute("style");
}

// Convert visual-editor markup into conservative, fully inlined email HTML. Theme styles
// are the base layer and editor styles are appended afterward, so user changes always win.
export function toEmailHtml(editorHtml: string, t: EmailTheme): string {
  const doc = new DOMParser().parseFromString(`<div id="__root">${editorHtml || ""}</div>`, "text/html");
  const root = doc.getElementById("__root") as HTMLElement | null;
  if (!root) return editorHtml || "";

  const blocks: HTMLElement[] = [];
  const flush = (nodes: Node[]) => {
    if (nodes.length === 0) return;
    const p = doc.createElement("p");
    nodes.forEach((node) => p.appendChild(node.cloneNode(true)));
    blocks.push(p);
  };

  let buffer: Node[] = [];
  Array.from(root.childNodes).forEach((node) => {
    const el = node as HTMLElement;
    const tag = el.tagName?.toLowerCase();
    if (tag === "p" || tag === "div") {
      flush(buffer);
      buffer = [];
      const p = doc.createElement("p");
      copyAttributes(el, p);
      p.innerHTML = el.innerHTML || "";
      blocks.push(p);
    } else if (tag === "ul" || tag === "ol" || tag === "table") {
      flush(buffer);
      buffer = [];
      blocks.push(el.cloneNode(true) as HTMLElement);
    } else if (tag === "br") {
      flush(buffer.length ? buffer : [doc.createTextNode("")]);
      buffer = [];
    } else {
      buffer.push(node);
    }
  });
  flush(buffer);

  // Empty editor paragraphs are not a reliable way to space a layout/signature table.
  // Browsers also synthesize them when repairing legacy <p><table>...</table></p>
  // markup, which made the signature gap grow again after every save.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].tagName.toLowerCase() !== "table") continue;
    let previous = index - 1;
    while (previous >= 0 && isBlankBlock(blocks[previous])) {
      blocks.splice(previous, 1);
      index -= 1;
      previous -= 1;
    }
  }
  while (blocks.length > 0 && isBlankBlock(blocks[blocks.length - 1])) blocks.pop();

  const output = blocks.map((block) => {
    const tag = block.tagName.toLowerCase();
    const own = block.getAttribute("style") || "";
    const blank = isBlankBlock(block);

    if (tag === "p") {
      block.setAttribute("style", `${paragraphStyle(t)}${own}`);
      if (blank && !block.hasAttribute("data-email-gap")) block.style.marginBottom = "0px";
      block.removeAttribute("data-empty-line");
      if (blank) block.innerHTML = "&nbsp;";
      return block.outerHTML;
    }

    if (tag === "table") return block.outerHTML;

    const listBase = t.key === "none"
      ? `margin:0 0 ${t.paragraphGap}px 0;padding-left:24px;`
      : `margin:0 0 ${t.paragraphGap}px 0;padding-left:24px;font-family:${t.fontFamily};font-size:${t.fontSize}px;line-height:${t.lineHeight}px;color:${t.color};`;
    block.setAttribute("style", `${listBase}${own}`);
    return block.outerHTML;
  }).join("");

  const baseStyle = containerStyle(t);
  const widthAttr = t.maxWidth == null ? "" : ` data-column-width="${t.maxWidth}"`;
  const styleAttr = baseStyle ? ` style="${baseStyle}"` : "";
  const wrapped = `<div data-theme="${t.key}"${widthAttr}${styleAttr}>${output}</div>`;
  const finalDoc = new DOMParser().parseFromString(wrapped, "text/html");
  finalDoc.querySelectorAll("a").forEach((a) => {
    const href = a.getAttribute("href");
    if (href) a.setAttribute("href", normalizeEmailLinkInput(repairDuplicateUrlProtocols(href)));
    if (!a.style.color) a.style.color = "#2563eb";
  });
  return finalDoc.body.innerHTML;
}

export function themeKeyOf(bodyHtml: string): string {
  const match = /<div[^>]*data-theme=["']([a-z0-9_-]+)["']/i.exec(bodyHtml || "");
  return match && EMAIL_THEMES.some((theme) => theme.key === match[1]) ? match[1] : "kingkong";
}

// Restore clean editor markup from stored email HTML. Generated theme declarations are
// removed while independent overrides and selection-level spans are left untouched.
export function fromEmailHtml(bodyHtml: string): string {
  // Older saves wrapped signature tables in paragraphs. Repair that invalid nesting
  // before DOMParser turns the wrapper into additional empty paragraphs.
  const repairedHtml = (bodyHtml || "").replace(
    /<p\b[^>]*>\s*(<table\b[\s\S]*?<\/table>)\s*<\/p>/gi,
    "$1",
  );
  const doc = new DOMParser().parseFromString(repairedHtml, "text/html");
  const first = doc.body.firstElementChild as HTMLElement | null;
  const hasThemeWrapper = doc.body.children.length === 1
    && first?.tagName.toLowerCase() === "div"
    && (first.hasAttribute("data-theme") || /max-width/i.test(first.getAttribute("style") || ""));
  const root = hasThemeWrapper && first ? first : doc.body;
  const storedTheme = themeByKey(themeKeyOf(bodyHtml));

  Array.from(root.children).forEach((child) => {
    const block = child as HTMLElement;
    if (["p", "div", "ul", "ol"].includes(block.tagName.toLowerCase())) prepareBlockForEditor(block, storedTheme);
  });

  return root.innerHTML;
}
