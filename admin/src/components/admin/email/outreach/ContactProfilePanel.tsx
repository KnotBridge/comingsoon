import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { OutreachContact } from "./types";
import { formatFollowers, PLATFORM_ICONS } from "./types";
import { X, ExternalLink, Save, Home, Eye, Wand2, Loader2, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { stageContactProperty, hasListingToStage } from "./stageProperty";

// One shared, sliding contact profile — opened from the Contacts table and from the
// Mailbox (the hover card / a conversation). Shows the contact, their listing, quick
// edits, and a one-click "Stage this property" that drops the listing's rooms straight
// into the current user's workspace (via the same claim path a recipient would use).

const STATUS_DOT: Record<string, string> = {
  new: "bg-blue-500", contacted: "bg-amber-400", replied: "bg-emerald-500",
  partner: "bg-violet-500", rejected: "bg-rose-400", unsubscribed: "bg-muted-foreground/40",
};
const STATUSES = ["new", "contacted", "replied", "partner", "rejected", "unsubscribed"] as const;

interface Props {
  open: boolean;
  onClose: () => void;
  contactId: string | null;
  /** Fallbacks when the counterparty isn't a saved contact (e.g. from the Mailbox). */
  fallbackEmail?: string;
  fallbackName?: string;
  onUpdated?: (c: OutreachContact) => void;
}

export default function ContactProfilePanel({ open, onClose, contactId, fallbackEmail, fallbackName, onUpdated }: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [render, setRender] = useState(open);
  const [slideIn, setSlideIn] = useState(false);
  const [contact, setContact] = useState<OutreachContact | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [staging, setStaging] = useState(false);
  const [fields, setFields] = useState({ name: "", email: "", username: "", platform: "", followers: "", status: "new", profile_url: "", notes: "", bio: "" });

  // Mount + slide animation.
  useEffect(() => {
    if (open) { setRender(true); const id = requestAnimationFrame(() => setSlideIn(true)); return () => cancelAnimationFrame(id); }
    setSlideIn(false);
    const t = window.setTimeout(() => setRender(false), 260);
    return () => window.clearTimeout(t);
  }, [open]);

  const applyContact = useCallback((c: OutreachContact | null) => {
    setContact(c);
    setFields({
      name: c?.name || fallbackName || "", email: c?.email || fallbackEmail || "", username: c?.username || "",
      platform: c?.platform || "", followers: c?.followers?.toString() || "", status: c?.status || "new",
      profile_url: c?.profile_url || "", notes: c?.notes || "", bio: c?.bio || "",
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
      // A message's contact_id can be stale (deleted/re-created); the email may still
      // map to a live contact, so fall through to it rather than showing "not saved".
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
      name: fields.name, email: fields.email.trim().toLowerCase(), username: fields.username || null,
      platform: (fields.platform as OutreachContact["platform"]) || null,
      followers: fields.followers ? parseInt(fields.followers) : null,
      status: fields.status as OutreachContact["status"],
      profile_url: fields.profile_url || null, notes: fields.notes || null, bio: fields.bio || null,
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

  const hasListing = hasListingToStage(contact);

  const openDynamicPage = async () => {
    if (!contact) return;
    const { data: existing } = await supabase.from("outreach_dynamic_pages")
      .select("token").eq("contact_id", contact.id).is("campaign_id", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    let token = (existing as { token?: string } | null)?.token;
    if (!token) {
      const { data: created, error } = await supabase.from("outreach_dynamic_pages")
        .insert({ contact_id: contact.id, recipient_email: contact.email, snapshot: listingSnapshot(contact) })
        .select("token").single();
      if (error || !created) { toast.error(error?.message || "Could not create preview link"); return; }
      token = (created as { token: string }).token;
    }
    window.open(`/r/${token}`, "_blank", "noopener,noreferrer");
  };

  // Drop the listing's rooms into the current user's workspace, in the background.
  const stageProperty = async () => {
    if (!contact || !user) return;
    if (!hasListing) { toast.error("This contact has no listing photos to stage"); return; }
    setStaging(true);
    try {
      const roomProjectId = await stageContactProperty(contact);
      toast.success("Property added to your workspace", {
        action: { label: "Open", onClick: () => navigate(`/projects?from=re-dynamic&spotlight=${roomProjectId}`) },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not stage the property");
    } finally {
      setStaging(false);
    }
  };

  if (!render) return null;
  const initial = (fields.name.trim()[0] || fields.email.trim()[0] || "?").toUpperCase();
  const imgs = contact?.listing_image_urls || [];

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className={cn("absolute inset-0 bg-black/40 transition-opacity duration-250", slideIn ? "opacity-100" : "opacity-0")}
        onClick={onClose}
      />
      {/* Drawer */}
      <div
        className={cn(
          "absolute right-0 top-0 h-full w-full max-w-[440px] bg-card border-l border-border shadow-2xl flex flex-col transition-transform duration-250 ease-out",
          slideIn ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* Header */}
        <div className="shrink-0 px-5 py-4 border-b border-border flex items-start gap-3">
          <div className="w-11 h-11 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 flex items-center justify-center text-base font-semibold text-primary flex-shrink-0">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground truncate">{fields.name || fields.email || "Contact"}</p>
            <p className="text-xs text-muted-foreground truncate">{fields.email}</p>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground capitalize">
                <span className={cn("w-1.5 h-1.5 rounded-full", STATUS_DOT[fields.status] || "bg-muted-foreground/40")} />
                {fields.status}
              </span>
              {fields.platform && <span className="text-[11px] text-muted-foreground">· {PLATFORM_ICONS[fields.platform as keyof typeof PLATFORM_ICONS]?.label || fields.platform}</span>}
              {fields.followers && <span className="text-[11px] text-muted-foreground">· {formatFollowers(Number(fields.followers))}</span>}
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
              <p className="text-xs text-muted-foreground mt-1">{fields.email || "This person"} isn't in your outreach contacts, so there's no listing to stage.</p>
            </div>
          )}

          {/* Stage this property — the headline action */}
          {contact && (
            <div className={cn("rounded-xl border p-3.5", hasListing ? "border-primary/30 bg-primary/5" : "border-border bg-muted/20")}>
              <div className="flex items-center gap-2 mb-1">
                <Building2 className="w-4 h-4 text-primary" />
                <p className="text-sm font-semibold text-foreground">{contact.street_address || "Their property"}</p>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                {hasListing
                  ? `${imgs.length || "The"} listing photo${imgs.length === 1 ? "" : "s"} ready to stage in your workspace.`
                  : "No listing photos on this contact yet."}
              </p>
              <div className="flex gap-2">
                <Button size="sm" className="gap-1.5 flex-1" onClick={stageProperty} disabled={!hasListing || staging}>
                  {staging ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                  {staging ? "Adding…" : "Stage this property"}
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={openDynamicPage} disabled={!hasListing} title="Open the recipient's dynamic landing page">
                  <Eye className="w-3.5 h-3.5" /> Page
                </Button>
              </div>
            </div>
          )}

          {/* Listing details */}
          {contact && hasListing && (
            <div className="space-y-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"><Home className="w-3 h-3" /> Listing</p>
              {imgs.length > 0 && (
                <div className="grid grid-cols-3 gap-1.5">
                  {imgs.slice(0, 6).map((url, i) => (
                    <a key={i} href={url} target="_blank" rel="noreferrer" className="aspect-square rounded-lg overflow-hidden bg-muted block hover:opacity-90 transition-opacity">
                      <img src={url} alt={`listing ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
                    </a>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                {contact.street_address && <Detail className="col-span-2" label="Address" value={`${contact.street_address}${contact.city ? `, ${contact.city}` : ""}${contact.property_state ? `, ${contact.property_state}` : ""} ${contact.property_zip || ""}`} />}
                {contact.listing_amount != null && <Detail label="Price" value={`$${contact.listing_amount.toLocaleString()}`} />}
                {contact.property_bedrooms != null && <Detail label="Beds" value={String(contact.property_bedrooms)} />}
                {contact.property_bathrooms != null && <Detail label="Baths" value={String(contact.property_bathrooms)} />}
                {contact.property_square_feet != null && <Detail label="Sq ft" value={contact.property_square_feet.toLocaleString()} />}
                {contact.property_year_built != null && <Detail label="Built" value={String(contact.property_year_built)} />}
                {contact.days_on_market != null && <Detail label="Days on market" value={String(contact.days_on_market)} />}
                {contact.property_type && <Detail className="col-span-2" label="Type" value={contact.property_type} />}
                {contact.agent_name && <Detail className="col-span-2" label="Agent" value={`${contact.agent_name}${contact.agent_phone ? ` · ${contact.agent_phone}` : ""}`} />}
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
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="Name"><Input value={fields.name} onChange={(e) => setField("name", e.target.value)} className="h-8 text-xs" /></Labeled>
                <Labeled label="Username"><Input value={fields.username} onChange={(e) => setField("username", e.target.value)} className="h-8 text-xs" placeholder="@handle" /></Labeled>
              </div>
              <Labeled label="Email"><Input value={fields.email} onChange={(e) => setField("email", e.target.value)} className="h-8 text-xs" type="email" /></Labeled>
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="Platform">
                  <select value={fields.platform} onChange={(e) => setField("platform", e.target.value)} className="w-full h-8 text-xs border border-input rounded-md px-2 bg-background">
                    <option value="">None</option>
                    {(["instagram", "tiktok", "youtube", "twitter", "other"] as const).map((p) => <option key={p} value={p}>{PLATFORM_ICONS[p]?.label || p}</option>)}
                  </select>
                </Labeled>
                <Labeled label="Followers"><Input value={fields.followers} onChange={(e) => setField("followers", e.target.value)} className="h-8 text-xs" type="number" /></Labeled>
              </div>
              <Labeled label="Profile URL">
                <div className="flex gap-1">
                  <Input value={fields.profile_url} onChange={(e) => setField("profile_url", e.target.value)} className="h-8 text-xs flex-1" placeholder="https://…" />
                  {fields.profile_url && <a href={fields.profile_url} target="_blank" rel="noreferrer" className="h-8 w-8 flex items-center justify-center border border-border rounded-md text-muted-foreground hover:text-foreground flex-shrink-0"><ExternalLink className="w-3.5 h-3.5" /></a>}
                </div>
              </Labeled>
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

function listingSnapshot(c: OutreachContact) {
  return {
    email: c.email, street_address: c.street_address, city: c.city, state: c.property_state, zip: c.property_zip,
    bedrooms: c.property_bedrooms, bathrooms: c.property_bathrooms, square_feet: c.property_square_feet,
    year_built: c.property_year_built, property_type: c.property_type, listing_amount: c.listing_amount,
    days_on_market: c.days_on_market, agent_name: c.agent_name, listing_image_urls: c.listing_image_urls,
  };
}

function Detail({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <span className="text-muted-foreground">{label}: </span>
      <span className="text-foreground">{value}</span>
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
