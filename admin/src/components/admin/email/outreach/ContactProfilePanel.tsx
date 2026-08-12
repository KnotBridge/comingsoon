import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { OutreachContact } from "./types";
import { X, ExternalLink, Save, Building2, Globe, MapPin, Phone, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// Shared sliding contact profile — opened from the Contacts table and the Mailbox.
// Shows the business, quick edits, and quick status changes.

const STATUS_DOT: Record<string, string> = {
  new: "bg-blue-500", contacted: "bg-amber-400", replied: "bg-emerald-500",
  interested: "bg-violet-500", customer: "bg-emerald-600", rejected: "bg-rose-400", unsubscribed: "bg-muted-foreground/40",
};
const STATUSES = ["new", "contacted", "replied", "interested", "customer", "rejected", "unsubscribed"] as const;

const catOf = (c: OutreachContact | null) => c ? (c.primary_category || (Array.isArray(c.categories) ? c.categories[0] : "") || "") : "";
const withProto = (u: string) => (/^https?:\/\//.test(u) ? u : `https://${u}`);

interface Props {
  open: boolean;
  onClose: () => void;
  contactId: string | null;
  fallbackEmail?: string;
  fallbackName?: string;
  onUpdated?: (c: OutreachContact) => void;
}

export default function ContactProfilePanel({ open, onClose, contactId, fallbackEmail, fallbackName, onUpdated }: Props) {
  const [render, setRender] = useState(open);
  const [slideIn, setSlideIn] = useState(false);
  const [contact, setContact] = useState<OutreachContact | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fields, setFields] = useState({ name: "", email: "", category: "", phone: "", website: "", city: "", state: "", status: "new", notes: "" });

  useEffect(() => {
    if (open) { setRender(true); const id = requestAnimationFrame(() => setSlideIn(true)); return () => cancelAnimationFrame(id); }
    setSlideIn(false);
    const t = window.setTimeout(() => setRender(false), 260);
    return () => window.clearTimeout(t);
  }, [open]);

  const applyContact = useCallback((c: OutreachContact | null) => {
    setContact(c);
    setFields({
      name: c?.name || fallbackName || "", email: c?.email || fallbackEmail || "",
      category: catOf(c), phone: c?.phone || "", website: c?.website_url || "",
      city: c?.city || "", state: c?.state || "", status: c?.status || "new", notes: c?.notes || "",
    });
  }, [fallbackEmail, fallbackName]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      let row: OutreachContact | null = null;
      if (contactId) {
        const { data } = await supabase.from("outreach_contacts").select("*").eq("id", contactId).maybeSingle();
        row = (data as OutreachContact) || null;
      }
      if (!row && fallbackEmail) {
        const { data } = await supabase.from("outreach_contacts").select("*").eq("email", fallbackEmail.toLowerCase()).maybeSingle();
        row = (data as OutreachContact) || null;
      }
      if (!cancelled) { applyContact(row); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [open, contactId, fallbackEmail, applyContact]);

  const setField = (k: keyof typeof fields, v: string) => setFields((p) => ({ ...p, [k]: v }));

  const save = async () => {
    if (!contact) return;
    setSaving(true);
    const updates = {
      name: fields.name, email: fields.email.trim().toLowerCase(),
      primary_category: fields.category || null, phone: fields.phone || null,
      website_url: fields.website || null, city: fields.city || null, state: fields.state || null,
      status: fields.status as OutreachContact["status"], notes: fields.notes || null,
    };
    const { error } = await supabase.from("outreach_contacts").update(updates).eq("id", contact.id);
    setSaving(false);
    if (error) { toast.error(error.message || "Failed to save"); return; }
    const updated = { ...contact, ...updates } as OutreachContact;
    setContact(updated);
    onUpdated?.(updated);
    toast.success("Saved");
  };

  const quickStatus = async (status: OutreachContact["status"]) => {
    setField("status", status || "new");
    if (!contact) return;
    await supabase.from("outreach_contacts").update({ status }).eq("id", contact.id);
    const updated = { ...contact, status } as OutreachContact;
    setContact(updated); onUpdated?.(updated);
  };

  if (!render) return null;
  const initial = (fields.name.trim()[0] || fields.email.trim()[0] || "?").toUpperCase();

  return (
    <div className="fixed inset-0 z-50">
      <div className={cn("absolute inset-0 bg-black/40 transition-opacity duration-250", slideIn ? "opacity-100" : "opacity-0")} onClick={onClose} />
      <div className={cn(
        "absolute right-0 top-0 h-full w-full max-w-[440px] bg-card border-l border-border shadow-2xl flex flex-col transition-transform duration-250 ease-out",
        slideIn ? "translate-x-0" : "translate-x-full",
      )}>
        {/* Header */}
        <div className="shrink-0 px-5 py-4 border-b border-border flex items-start gap-3">
          <div className="w-11 h-11 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 flex items-center justify-center text-base font-semibold text-primary flex-shrink-0">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground truncate">{fields.name || fields.email || "Contact"}</p>
            <p className="text-xs text-muted-foreground truncate">{fields.email}</p>
            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground capitalize">
                <span className={cn("w-1.5 h-1.5 rounded-full", STATUS_DOT[fields.status] || "bg-muted-foreground/40")} />
                {fields.status}
              </span>
              {fields.category && <span className="text-[11px] text-muted-foreground">· {fields.category}</span>}
              {contact?.rating != null && (
                <span className="text-[11px] text-muted-foreground inline-flex items-center gap-0.5">· <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400" />{contact.rating}{contact.review_count != null ? ` (${contact.review_count})` : ""}</span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          {loading && !contact && <p className="text-xs text-muted-foreground">Loading…</p>}
          {!loading && !contact && (
            <div className="rounded-xl border border-dashed border-border p-4 text-center">
              <p className="text-sm text-foreground font-medium">Not a saved contact</p>
              <p className="text-xs text-muted-foreground mt-1">{fields.email || "This person"} isn't in your outreach contacts yet.</p>
            </div>
          )}

          {/* Business info */}
          {contact && (contact.address || contact.website_url || contact.phone || contact.maps_url) && (
            <div className="rounded-xl border border-border bg-muted/20 p-3.5 space-y-2">
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-primary" />
                <p className="text-sm font-semibold text-foreground truncate">{contact.name}</p>
              </div>
              <div className="space-y-1.5 text-xs text-muted-foreground">
                {contact.address && (
                  <div className="flex gap-1.5"><MapPin className="w-3 h-3 mt-0.5 flex-shrink-0" /><span>{contact.address}{contact.city ? `, ${contact.city}` : ""}{contact.state ? `, ${contact.state}` : ""} {contact.postal_code || ""}</span></div>
                )}
                {contact.phone && <div className="flex gap-1.5 items-center"><Phone className="w-3 h-3 flex-shrink-0" /><span>{contact.phone}</span></div>}
                {contact.website_url && <div className="flex gap-1.5 items-center"><Globe className="w-3 h-3 flex-shrink-0" /><a href={withProto(contact.website_url)} target="_blank" rel="noreferrer" className="text-primary hover:underline truncate">{contact.website_url}</a></div>}
                {contact.maps_url && <a href={contact.maps_url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1"><ExternalLink className="w-3 h-3" /> View on Google Maps</a>}
              </div>
            </div>
          )}

          {/* Quick status */}
          {contact && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Status</p>
              <div className="flex flex-wrap gap-1.5">
                {STATUSES.map((s) => (
                  <button key={s} onClick={() => quickStatus(s)}
                    className={cn("text-[11px] px-2.5 py-1 rounded-full border capitalize transition-colors inline-flex items-center gap-1.5",
                      fields.status === s ? "border-foreground/30 bg-muted text-foreground" : "border-border text-muted-foreground hover:bg-muted/50")}>
                    <span className={cn("w-1.5 h-1.5 rounded-full", STATUS_DOT[s])} /> {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Editable fields */}
          {contact && (
            <div className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Details</p>
              <Labeled label="Business name"><Input value={fields.name} onChange={(e) => setField("name", e.target.value)} className="h-8 text-xs" /></Labeled>
              <Labeled label="Email"><Input value={fields.email} onChange={(e) => setField("email", e.target.value)} className="h-8 text-xs" type="email" /></Labeled>
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="Category"><Input value={fields.category} onChange={(e) => setField("category", e.target.value)} className="h-8 text-xs" placeholder="Medical spa" /></Labeled>
                <Labeled label="Phone"><Input value={fields.phone} onChange={(e) => setField("phone", e.target.value)} className="h-8 text-xs" placeholder="(555) 555-5555" /></Labeled>
              </div>
              <Labeled label="Website">
                <div className="flex gap-1">
                  <Input value={fields.website} onChange={(e) => setField("website", e.target.value)} className="h-8 text-xs flex-1" placeholder="business.com" />
                  {fields.website && <a href={withProto(fields.website)} target="_blank" rel="noreferrer" className="h-8 w-8 flex items-center justify-center border border-border rounded-md text-muted-foreground hover:text-foreground flex-shrink-0"><ExternalLink className="w-3.5 h-3.5" /></a>}
                </div>
              </Labeled>
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="City"><Input value={fields.city} onChange={(e) => setField("city", e.target.value)} className="h-8 text-xs" placeholder="Austin" /></Labeled>
                <Labeled label="State"><Input value={fields.state} onChange={(e) => setField("state", e.target.value)} className="h-8 text-xs" placeholder="TX" /></Labeled>
              </div>
              <Labeled label="Notes"><Textarea value={fields.notes} onChange={(e) => setField("notes", e.target.value)} className="text-xs min-h-[60px] resize-none" placeholder="Private notes…" /></Labeled>
            </div>
          )}
        </div>

        {/* Footer */}
        {contact && (
          <div className="shrink-0 border-t border-border p-3 flex justify-end">
            <Button size="sm" onClick={save} disabled={saving} className="gap-1.5">
              <Save className="w-3.5 h-3.5" /> {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground mb-1">{label}</p>
      {children}
    </div>
  );
}
