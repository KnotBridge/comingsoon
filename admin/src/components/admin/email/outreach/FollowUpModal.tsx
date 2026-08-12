import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { X, Send, Loader2, FileText, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { queueAndSend } from "./sendMail";
import { buildEmailPreviewSrcDoc } from "./emailPreview";

// Starred templates float to the top of the picker. Stored locally so it's instant;
// can move to the DB later if you want it shared across devices.
const PIN_KEY = "renov_pinned_templates";
const loadPins = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || "[]")); } catch { return new Set(); } };
const savePins = (s: Set<string>) => { try { localStorage.setItem(PIN_KEY, JSON.stringify([...s])); } catch { /* ignore */ } };

interface Tag { id: string; label: string; color: string }
interface Tpl { id: string; name: string; subject: string | null; body_html: string | null; email_format?: string | null; tracking_image_url?: string | null }

interface Props {
  open: boolean;
  onClose: () => void;
  to: string;
  contactId: string | null;
  contactName: string;
  tags: Tag[];
  onSent: () => void;
}

// Build the {{placeholder}} values from a contact row, mirroring the flow engine.
function contactVars(c: any): Record<string, string> {
  if (!c) return {};
  const name = c.name || c.agent_name || "";
  const first = name.split(/\s+/)[0] || "";
  const d = new Date(Date.now() + 7 * 86400e3);
  return {
    name, first_name: first,
    agent_name: c.agent_name || "", agent_first_name: (c.agent_name || "").split(/\s+/)[0] || "",
    street_address: c.street_address || "", city: c.city || "", email: c.email || "",
    days_on_market: c.days_on_market != null ? String(c.days_on_market) : "",
    listing_amount: c.listing_amount != null ? String(c.listing_amount) : "",
    deadline: d.toLocaleDateString("en-US", { month: "long", day: "numeric" }), trial_days: "7",
  };
}
function substitute(text: string, vars: Record<string, string>): string {
  return (text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (vars[k] != null && vars[k] !== "" ? String(vars[k]) : `{{${k}}}`));
}
function leftoverKeys(text: string): string[] {
  const s = new Set<string>();
  (text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => { s.add(k); return ""; });
  return [...s];
}

export default function FollowUpModal({ open, onClose, to, contactId, contactName, tags, onSent }: Props) {
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [contact, setContact] = useState<any>(null);
  const [tplId, setTplId] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyTemplate, setBodyTemplate] = useState("");
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [rawEdit, setRawEdit] = useState(false);
  const [bodyRaw, setBodyRaw] = useState("");
  const [tagId, setTagId] = useState("");
  const [sending, setSending] = useState(false);
  const [pinned, setPinned] = useState<Set<string>>(loadPins);
  const togglePin = (id: string) => setPinned((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); savePins(n); return n; });

  useEffect(() => {
    if (!open) return;
    supabase.from("outreach_templates").select("id,name,subject,body_html,email_format,tracking_image_url").order("name").then(({ data }) => setTemplates((data as any[]) || []));
    setTagId(tags.find((t) => /offer sent/i.test(t.label))?.id || "");
    if (contactId) supabase.from("outreach_contacts").select("*").eq("id", contactId).maybeSingle().then(({ data }) => setContact(data));
    else setContact({ name: contactName, email: to });
  }, [open, contactId, contactName, to, tags]);

  const vars = useMemo(() => contactVars(contact), [contact]);
  // Starred first, then alphabetical.
  const sortedTemplates = useMemo(
    () => [...templates].sort((a, b) => (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0) || (a.name || "").localeCompare(b.name || "")),
    [templates, pinned],
  );

  const pickTemplate = (id: string) => {
    setTplId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setSubject(substitute(t.subject || "", vars));
    setBodyTemplate(t.body_html || "");
    setExtra({});
    setRawEdit(false);
  };

  const pickedTpl = useMemo(() => templates.find((x) => x.id === tplId), [templates, tplId]);
  const effectiveBody = useMemo(() => rawEdit ? bodyRaw : substitute(bodyTemplate, { ...vars, ...extra }), [rawEdit, bodyRaw, bodyTemplate, vars, extra]);
  // {{tracked_image}} is resolved at send time, not a real leftover — don't warn on it.
  const leftovers = useMemo(() => leftoverKeys(substitute(bodyTemplate, vars)).filter((k) => !(k in vars) && k.toLowerCase() !== "tracked_image"), [bodyTemplate, vars]);

  const sendNow = async () => {
    if (!to) return;
    if (!effectiveBody.trim()) { toast.error("Pick a template first"); return; }
    setSending(true);
    try {
      // A plain template must send as plain text, else its line breaks collapse. Carry the
      // tracked image through so the worker can resolve {{tracked_image}}.
      await queueAndSend(to, subject || "(no subject)", effectiveBody, {
        plainText: pickedTpl?.email_format === "plain",
        trackingImageUrl: pickedTpl?.tracking_image_url || null,
      });
      if (tagId && contactId) await supabase.from("contact_tags" as any).insert({ contact_id: contactId, tag_id: tagId }).then(({ error: e }) => { if (e && !/duplicate/i.test(e.message)) console.warn(e.message); });
      toast.success(`Sent to ${to}`);
      onSent();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally { setSending(false); }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-card rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-shrink-0">
          <div>
            <h3 className="font-semibold text-foreground text-sm flex items-center gap-2"><FileText className="w-4 h-4" /> Template</h3>
            <p className="text-xs text-muted-foreground">to {contactName || to} · {to}</p>
          </div>
          <button onClick={onClose}><X className="w-4 h-4 text-muted-foreground" /></button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 p-5 grid grid-cols-2 gap-4">
          {/* Left: controls */}
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Template <span className="text-muted-foreground/60">· star to pin to the top</span></label>
              <div className="border border-input rounded-md bg-background max-h-56 overflow-y-auto divide-y divide-border/40">
                {sortedTemplates.length === 0 && <p className="text-xs text-muted-foreground p-3 text-center">No templates</p>}
                {sortedTemplates.map((t) => {
                  const isPinned = pinned.has(t.id);
                  const isSel = tplId === t.id;
                  return (
                    <div key={t.id} onClick={() => pickTemplate(t.id)}
                      className={cn("flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-muted/40 transition-colors", isSel && "bg-primary/10", isPinned && !isSel && "bg-amber-50/60")}>
                      <button type="button" title={isPinned ? "Unstar" : "Star (show first)"} onClick={(e) => { e.stopPropagation(); togglePin(t.id); }} className="flex-shrink-0">
                        <Star className={cn("w-3.5 h-3.5 transition-colors", isPinned ? "fill-amber-400 text-amber-500" : "text-muted-foreground/40 hover:text-amber-500")} />
                      </button>
                      <span className={cn("text-sm truncate flex-1", isSel && "font-medium text-primary")}>{t.name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full h-9 text-sm border border-input rounded-md px-3 bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
            </div>

            {leftovers.length > 0 && (
              <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                <p className="text-[11px] font-medium text-amber-700">Fill these (not on the contact):</p>
                {leftovers.map((k) => (
                  <div key={k}>
                    <label className="text-[11px] text-muted-foreground mb-0.5 block">{k.replace(/_/g, " ")}</label>
                    <input value={extra[k] || ""} onChange={(e) => setExtra((p) => ({ ...p, [k]: e.target.value }))}
                      placeholder={k === "offer_link" ? "Paste the offer link…" : `{{${k}}}`}
                      className="w-full h-8 text-sm border border-input rounded-md px-2 bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
                  </div>
                ))}
              </div>
            )}

            {tplId && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={rawEdit} onChange={(e) => { setRawEdit(e.target.checked); if (e.target.checked) setBodyRaw(substitute(bodyTemplate, { ...vars, ...extra })); }} />
                Edit the body by hand
              </label>
            )}
            {rawEdit && (
              <textarea value={bodyRaw} onChange={(e) => setBodyRaw(e.target.value)} className="w-full text-xs font-mono border border-input rounded-md p-2 bg-background min-h-[160px] resize-y" />
            )}

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Tag after sending</label>
              <select value={tagId} onChange={(e) => setTagId(e.target.value)} className="w-full h-9 text-sm border border-input rounded-md px-2 bg-background" disabled={!contactId}>
                <option value="">No tag</option>
                {tags.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
          </div>

          {/* Right: live preview */}
          <div className="flex flex-col">
            <label className="text-xs text-muted-foreground mb-1 block">Preview</label>
            <div className="flex-1 border border-border rounded-lg overflow-hidden bg-white min-h-[300px]">
              {tplId ? (
                <iframe title="preview" sandbox="allow-same-origin" className="w-full h-full border-0"
                  srcDoc={buildEmailPreviewSrcDoc({ body: effectiveBody, format: pickedTpl?.email_format, trackingImageUrl: pickedTpl?.tracking_image_url, fill: (s) => s })} />
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground p-6 text-center">Pick a template to preview the filled email</div>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border flex-shrink-0">
          <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="gap-1.5" onClick={sendNow} disabled={sending || !tplId}>
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}{sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
