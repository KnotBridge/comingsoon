import { useRef, useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Bold, Italic, Underline, List, ListOrdered, Link2, PenLine, FileText, Send, Loader2, ChevronDown, Star, PenSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildEmailPreviewSrcDoc } from "./emailPreview";

// Named email styles ("themes"). King Kong = the exact house look (Helvetica/Arial,
// 20px, black). Applied when you WRITE freeform; templates keep their own styling.
export interface EmailStyle { name: string; fontFamily: string; fontSize: string; color: string; lineHeight: string }
export const EMAIL_STYLES: Record<string, EmailStyle> = {
  kingkong: { name: "King Kong", fontFamily: "Helvetica, Arial, sans-serif", fontSize: "20px", color: "#000000", lineHeight: "1.5" },
  clean: { name: "Clean", fontFamily: "Arial, Helvetica, sans-serif", fontSize: "15px", color: "#111111", lineHeight: "1.55" },
};
const styleCss = (s: EmailStyle) => `font-family:${s.fontFamily};font-size:${s.fontSize};line-height:${s.lineHeight};color:${s.color};`;

const SIG_KEY = "renov_email_signature";
const DEFAULT_SIG = "Justin\nHead of Growth, Renov";
const getSig = () => { try { return localStorage.getItem(SIG_KEY) ?? DEFAULT_SIG; } catch { return DEFAULT_SIG; } };
const saveSig = (v: string) => { try { localStorage.setItem(SIG_KEY, v); } catch { /* ignore */ } };
const PIN_KEY = "renov_pinned_templates";
const loadPins = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || "[]")); } catch { return new Set(); } };
const savePins = (s: Set<string>) => { try { localStorage.setItem(PIN_KEY, JSON.stringify([...s])); } catch { /* ignore */ } };

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sigToHtml = (sig: string) => sig.split("\n").map((l) => escapeHtml(l)).join("<br>");

// ── Template dynamic content ────────────────────────────────────────────────
interface Tpl { id: string; name: string; subject: string | null; body_html: string | null; email_format?: string | null; tracking_image_url?: string | null }
// Fill {{tags}} with values everywhere they appear (body text AND link hrefs). A tag
// with no value is dropped entirely, so a raw {{tag}} is never sent — EXCEPT sender_*
// tags (resolved server-side from the sending mailbox) and {{tracked_image}} (resolved by
// the send worker into the real image), which are left intact.
const isSenderTag = (k: string) => /^sender_/i.test(k);
const isKeepTag = (k: string) => isSenderTag(k) || k.toLowerCase() === "tracked_image";
function fillTags(html: string, values: Record<string, string>): string {
  return (html || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
    if (isKeepTag(k)) return m; // resolved server-side (sender identity / tracked image)
    const v = values[k];
    return v != null && String(v).trim() !== "" ? String(v) : "";
  });
}
// Sender tags for the preview only, so it reads "Justin H." instead of a raw tag. The
// actual send keeps them raw for the worker. From name "Justin H." → first "Justin".
function senderPreviewVars(sender?: { name?: string; email?: string }): Record<string, string> {
  const full = (sender?.name || "").trim();
  const parts = full.split(/\s+/).filter(Boolean);
  return {
    sender_name: full || "your name",
    sender_full_name: full || "your name",
    sender_first_name: parts[0] || "your name",
    sender_last_name: parts.slice(1).join(" "),
    sender_email: sender?.email || "you@yourdomain.com",
  };
}
function fillPreview(html: string, values: Record<string, string>, sender?: { name?: string; email?: string }): string {
  const sv = senderPreviewVars(sender);
  return (html || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
    if (k.toLowerCase() === "tracked_image") return m; // resolved by the preview renderer
    if (isSenderTag(k)) return sv[k.toLowerCase()] ?? "";
    const v = values[k];
    return v != null && String(v).trim() !== "" ? String(v) : "";
  });
}
function tagList(html: string): string[] {
  const s = new Set<string>();
  (html || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => { if (!isKeepTag(k)) s.add(k); return ""; });
  return [...s];
}
// Values we can auto-fill from the contact row (mirrors the send worker).
function contactVars(c: any, fallback: { email?: string; name?: string }): Record<string, string> {
  const name = c?.name || fallback.name || "";
  const first = name.split(/\s+/)[0] || "";
  const cat = c?.primary_category || (Array.isArray(c?.categories) ? c.categories[0] : "") || "";
  return {
    business_name: name, name, first_name: first,
    category: cat, city: c?.city || "", state: c?.state || "",
    website: c?.website_url || c?.domain || "", phone: c?.phone || "",
    rating: c?.rating != null ? String(c.rating) : "",
    review_count: c?.review_count != null ? String(c.review_count) : "",
    email: c?.email || fallback.email || "",
  };
}
const humanizeTag = (k: string) => k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Turn bare URLs sitting in plain text into real clickable links. DOM-based so it
// only touches text nodes — URLs already inside an <a>, or inside an attribute like
// href="{{tag}}", are left alone (no double-wrapping, no broken attributes).
function autolink(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const el = (node as Text).parentElement;
      if (el && el.closest("a")) continue; // already a link
      if (/https?:\/\/[^\s<]+/.test((node as Text).nodeValue || "")) targets.push(node as Text);
    }
    for (const t of targets) {
      const parts = (t.nodeValue || "").split(/(https?:\/\/[^\s<]+)/g);
      if (parts.length < 2) continue;
      const frag = doc.createDocumentFragment();
      for (const p of parts) {
        if (/^https?:\/\//.test(p)) {
          const a = doc.createElement("a");
          a.setAttribute("href", p); a.setAttribute("target", "_blank"); a.textContent = p;
          frag.appendChild(a);
        } else if (p) frag.appendChild(doc.createTextNode(p));
      }
      t.replaceWith(frag);
    }
    return doc.body.innerHTML;
  } catch { return html; }
}

interface Props {
  compact?: boolean;
  sending?: boolean;
  placeholder?: string;
  onSend: (html: string, opts?: { plainText?: boolean; trackingImageUrl?: string | null; templateId?: string | null }) => void | Promise<void>;
  // Contact context for template auto-fill (reply: the person you're replying to).
  contact?: { id?: string | null; email?: string; name?: string };
  onSubject?: (subject: string) => void; // template sets the subject (used by Compose)
  // The mailbox this will send from, so the preview can resolve sender_* tags to its
  // "From" name. The actual send always leaves them for the worker.
  sender?: { name?: string; email?: string };
}

export default function RichComposer({ compact, sending, placeholder, onSend, contact, onSubject, sender }: Props) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<"write" | "template">("write");
  const [plainText, setPlainText] = useState(false); // send as raw text, no HTML wrapper
  const [styleKey, setStyleKey] = useState<string>("kingkong");
  const [styleMenu, setStyleMenu] = useState(false);
  const [sigOpen, setSigOpen] = useState(false);
  const [sig, setSig] = useState(getSig());
  const style = EMAIL_STYLES[styleKey] || EMAIL_STYLES.kingkong;

  // Template state
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [pinned, setPinned] = useState<Set<string>>(loadPins);
  const [picked, setPicked] = useState<Tpl | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    supabase.from("outreach_templates").select("id,name,subject,body_html,email_format,tracking_image_url").order("name").then(({ data }) => setTemplates((data as any[]) || []));
  }, []);
  // Build auto-fill values from the contact when we know one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let row: any = null;
      if (contact?.id) { const { data } = await supabase.from("outreach_contacts").select("*").eq("id", contact.id).maybeSingle(); row = data; }
      if (!cancelled) setVars(contactVars(row, { email: contact?.email, name: contact?.name }));
    })();
    return () => { cancelled = true; };
  }, [contact?.id, contact?.email, contact?.name]);

  const togglePin = (id: string) => setPinned((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); savePins(n); return n; });
  const sortedTemplates = useMemo(
    () => [...templates].sort((a, b) => (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0) || (a.name || "").localeCompare(b.name || "")),
    [templates, pinned],
  );

  const pickTemplate = (t: Tpl) => {
    setPicked(t);
    const tags = tagList(`${t.body_html || ""} ${t.subject || ""}`);
    // Pre-fill each tag with the known contact value (still overridable).
    const f: Record<string, string> = {};
    for (const k of tags) f[k] = vars[k] || "";
    setFields(f);
    if (onSubject) onSubject(fillTags(t.subject || "", { ...vars }));
  };
  // Full preview srcDoc — format-aware (plain vs HTML) and resolves {{tracked_image}},
  // exactly matching what the worker sends.
  const previewDoc = useMemo(
    () => picked ? buildEmailPreviewSrcDoc({ body: picked.body_html || "", format: picked.email_format, trackingImageUrl: picked.tracking_image_url, fill: (s) => fillPreview(s, { ...vars, ...fields }, sender) }) : "",
    [picked, vars, fields, sender],
  );
  // Tags still empty — shown as "unfilled" hints; dropped on send.
  const emptyTags = useMemo(() => picked ? tagList(picked.body_html || "").filter((k) => !(fields[k] && fields[k].trim())) : [], [picked, fields]);

  // ── Write mode helpers ──
  const exec = (cmd: string, val?: string) => { editorRef.current?.focus(); document.execCommand(cmd, false, val); };
  const addLink = () => { const url = window.prompt("Link URL (https://…):"); if (url) exec("createLink", /^https?:\/\//i.test(url) ? url : `https://${url}`); };
  const insertSig = () => { editorRef.current?.focus(); document.execCommand("insertHTML", false, `<br><br>${sigToHtml(sig)}`); };

  const handleSend = async () => {
    if (mode === "template") {
      if (!picked) return;
      // Fill everything we have; drop any tag left empty so no {{raw}} goes out. A PLAIN
      // template must send as plain text (no HTML wrapper / autolink), else its line breaks
      // collapse into an ugly wall — this is the fix for "ugly plain reply".
      const filled = fillTags(picked.body_html || "", { ...vars, ...fields });
      const trackingImageUrl = picked.tracking_image_url || null;
      if (picked.email_format === "plain") {
        await onSend(filled, { plainText: true, trackingImageUrl, templateId: picked.id });
      } else {
        await onSend(autolink(filled), { trackingImageUrl, templateId: picked.id });
      }
      setPicked(null); setFields({}); setMode("write");
      return;
    }
    // Plain text: send exactly what's typed, no HTML wrapper. innerText keeps the line
    // breaks the writer put in; the worker sends it as text/plain.
    if (plainText) {
      const text = editorRef.current?.innerText || "";
      if (!text.trim()) return;
      await onSend(text, { plainText: true });
      if (editorRef.current) editorRef.current.innerHTML = "";
      return;
    }
    const raw = editorRef.current?.innerHTML || "";
    if (!raw.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim()) return;
    const inner = raw
      .replace(/<ul>/gi, '<ul style="list-style:disc;padding-left:24px;margin:8px 0">')
      .replace(/<ol>/gi, '<ol style="list-style:decimal;padding-left:24px;margin:8px 0">');
    await onSend(autolink(`<div style="${styleCss(style)}">${inner}</div>`));
    if (editorRef.current) editorRef.current.innerHTML = "";
  };

  const Tool = ({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) => (
    <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className="w-7 h-7 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground">{children}</button>
  );

  return (
    <div className="border border-input rounded-lg bg-background overflow-visible">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-border flex-wrap">
        {mode === "write" ? (
          <>
            <Tool onClick={() => exec("bold")} title="Bold"><Bold className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={() => exec("italic")} title="Italic"><Italic className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={() => exec("underline")} title="Underline"><Underline className="w-3.5 h-3.5" /></Tool>
            <span className="w-px h-4 bg-border mx-0.5" />
            <Tool onClick={() => exec("insertUnorderedList")} title="Bulleted list"><List className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={() => exec("insertOrderedList")} title="Numbered list"><ListOrdered className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={addLink} title="Insert link"><Link2 className="w-3.5 h-3.5" /></Tool>
            <span className="w-px h-4 bg-border mx-0.5" />
            <div className="relative">
              <button type="button" onClick={() => setStyleMenu((v) => !v)} className="inline-flex items-center gap-1 text-[11px] px-1.5 h-7 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                {style.name}<ChevronDown className="w-3 h-3" />
              </button>
              {styleMenu && (
                <div className="absolute z-30 mt-1 bg-popover border border-border rounded-md shadow-lg py-1 min-w-[130px]">
                  {Object.entries(EMAIL_STYLES).map(([k, s]) => (
                    <button key={k} onClick={() => { setStyleKey(k); setStyleMenu(false); }} className={cn("w-full text-left px-2.5 py-1 text-xs hover:bg-muted", k === styleKey && "font-semibold text-primary")}>{s.name}</button>
                  ))}
                </div>
              )}
            </div>
            <Tool onClick={insertSig} title="Insert signature"><PenLine className="w-3.5 h-3.5" /></Tool>
            <button type="button" onClick={() => setSigOpen((v) => !v)} className="text-[10px] text-muted-foreground hover:text-foreground px-1">edit sig</button>
            <button type="button" onClick={() => setPlainText((v) => !v)}
              title="Plain text: send exactly what you type, no formatting or HTML"
              className={cn("text-[10px] px-1.5 h-6 rounded border transition-colors", plainText ? "border-primary text-primary bg-primary/5 font-medium" : "border-border text-muted-foreground hover:text-foreground")}>
              Plain
            </button>
            <Tool onClick={() => setMode("template")} title="Use a template"><FileText className="w-3.5 h-3.5" /></Tool>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground px-1"><FileText className="w-3.5 h-3.5" /> Template</span>
            {picked && (
              <>
                <span className="text-[11px] text-foreground truncate max-w-[150px]">{picked.name}</span>
                <button type="button" onClick={() => { setPicked(null); setFields({}); }} className="text-[10px] text-primary hover:underline px-1">change</button>
              </>
            )}
            <Tool onClick={() => setMode("write")} title="Back to writing"><PenSquare className="w-3.5 h-3.5" /></Tool>
          </>
        )}
        <div className="flex-1" />
        <Button size="sm" className="h-7 text-xs gap-1.5" onClick={handleSend} disabled={sending || (mode === "template" && !picked)}>
          {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}{sending ? "Sending…" : "Send"}
        </Button>
      </div>

      {/* Signature editor (write mode) */}
      {mode === "write" && sigOpen && (
        <div className="px-2.5 py-2 border-b border-border bg-muted/20">
          <p className="text-[10px] text-muted-foreground mb-1">Your signature — paste it here; the pen button drops it into the email.</p>
          <textarea value={sig} onChange={(e) => setSig(e.target.value)} onBlur={() => saveSig(sig)} rows={3}
            className="w-full border border-input rounded px-2 py-1 text-xs bg-background focus:outline-none focus:ring-1 focus:ring-ring resize-none" />
        </div>
      )}

      {mode === "write" ? (
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          data-ph={placeholder || "Write your email…"}
          className={cn(
            "px-3 py-2 outline-none overflow-y-auto break-words empty:before:content-[attr(data-ph)] empty:before:text-muted-foreground/50",
            "[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_ul]:my-1 [&_ol]:my-1 [&_a]:text-blue-600 [&_a]:underline",
            compact ? "min-h-[80px] max-h-[240px]" : "min-h-[220px] max-h-[440px]",
          )}
          style={{ fontFamily: style.fontFamily, fontSize: style.fontSize, color: style.color, lineHeight: style.lineHeight }}
        />
      ) : (
        <div className="flex flex-col">
          {!picked ? (
            <div className="max-h-[280px] overflow-y-auto divide-y divide-border/40">
              <p className="text-[10px] text-muted-foreground px-3 py-1.5">Pick a template · star to pin to the top</p>
              {sortedTemplates.length === 0 && <p className="text-xs text-muted-foreground px-3 py-4 text-center">No templates</p>}
              {sortedTemplates.map((t) => {
                const isP = pinned.has(t.id);
                return (
                  <div key={t.id} onClick={() => pickTemplate(t)} className={cn("flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/40", isP && "bg-amber-50/50")}>
                    <button type="button" onClick={(e) => { e.stopPropagation(); togglePin(t.id); }} title={isP ? "Unstar" : "Star (show first)"} className="flex-shrink-0">
                      <Star className={cn("w-3.5 h-3.5", isP ? "fill-amber-400 text-amber-500" : "text-muted-foreground/40 hover:text-amber-500")} />
                    </button>
                    <span className="text-sm truncate flex-1">{t.name}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <>
              {/* Dynamic fields — every {{tag}} in the template, editable, works for text AND links */}
              {Object.keys(fields).length > 0 && (
                <div className="px-3 py-2 border-b border-border bg-muted/10 space-y-1.5 max-h-40 overflow-y-auto">
                  <p className="text-[10px] font-medium text-muted-foreground">Dynamic content — override anything; blanks are dropped (never sent as a tag).</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {Object.keys(fields).map((k) => (
                      <label key={k} className="flex flex-col gap-0.5">
                        <span className={cn("text-[10px]", (fields[k] && fields[k].trim()) ? "text-muted-foreground" : "text-amber-600 font-medium")}>{humanizeTag(k)}</span>
                        <input value={fields[k]} onChange={(e) => setFields((p) => ({ ...p, [k]: e.target.value }))}
                          placeholder={`{{${k}}}`} className="h-7 text-xs border border-input rounded px-2 bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
                      </label>
                    ))}
                  </div>
                  {emptyTags.length > 0 && <p className="text-[10px] text-amber-600">Empty and will be removed: {emptyTags.map((t) => humanizeTag(t)).join(", ")}</p>}
                </div>
              )}
              {/* Live preview of exactly what will be sent */}
              <iframe title="template preview" sandbox="allow-same-origin"
                className={cn("w-full border-0 bg-white", compact ? "h-[220px]" : "h-[340px]")}
                srcDoc={previewDoc} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
