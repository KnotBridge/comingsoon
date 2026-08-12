import { useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { OutreachAudience, OutreachContact } from "./types";
import { formatFollowers, PLATFORM_ICONS } from "./types";
import { useNavigate } from "react-router-dom";
import { Search, ChevronLeft, ChevronRight, Mail, Trash2, ExternalLink, X, ChevronDown, Save, Plus, Eye, Home, Wand2 } from "lucide-react";
import { stageContactProperty } from "./stageProperty";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Props {
  audiences: OutreachAudience[];
  onCompose?: (emails: string[]) => void;
}

const PAGE_SIZE = 50;
const STATUSES = ["all", "new", "contacted", "replied", "partner", "rejected", "unsubscribed"] as const;
const PLATFORMS = ["all", "instagram", "tiktok", "youtube", "twitter", "other"] as const;
const FOLLOWER_RANGES = [
  { label: "All", min: 0, max: Infinity },
  { label: "Under 10k", min: 0, max: 10000 },
  { label: "10k–100k", min: 10000, max: 100000 },
  { label: "100k–1M", min: 100000, max: 1000000 },
  { label: "1M+", min: 1000000, max: Infinity },
];

// Quiet status dots — a status is a word, not a filled pill.
const STATUS_DOT: Record<string, string> = {
  new: "bg-muted-foreground/40",
  contacted: "bg-amber-400",
  replied: "bg-emerald-500",
  partner: "bg-primary",
  rejected: "bg-rose-400",
  unsubscribed: "bg-muted-foreground/30",
};

type EditFields = {
  name: string;
  email: string;
  username: string;
  platform: string;
  followers: string;
  bio: string;
  profile_url: string;
  source: string;
  status: string;
  notes: string;
};

export default function ContactsPage({ audiences, onCompose }: Props) {
  const navigate = useNavigate();
  const [stagingId, setStagingId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<OutreachContact[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [audienceFilter, setAudienceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [followerRange, setFollowerRange] = useState(0);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailContact, setDetailContact] = useState<OutreachContact | null>(null);
  const [editFields, setEditFields] = useState<EditFields>({ name: "", email: "", username: "", platform: "", followers: "", bio: "", profile_url: "", source: "", status: "new", notes: "" });
  const [saving, setSaving] = useState(false);
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newContact, setNewContact] = useState({ name: "", email: "", username: "", platform: "", followers: "", profile_url: "", audience_id: "", notes: "" });

  const resetNewContact = () => setNewContact({ name: "", email: "", username: "", platform: "", followers: "", profile_url: "", audience_id: "", notes: "" });

  const createContact = async () => {
    if (!newContact.name.trim() || !newContact.email.trim()) {
      toast.error("Name and email are required");
      return;
    }
    setAdding(true);
    const payload = {
      name: newContact.name.trim(),
      email: newContact.email.trim().toLowerCase(),
      username: newContact.username.trim() || null,
      platform: (newContact.platform || null) as OutreachContact["platform"],
      followers: newContact.followers ? parseInt(newContact.followers) : null,
      profile_url: newContact.profile_url.trim() || null,
      audience_id: newContact.audience_id || null,
      notes: newContact.notes.trim() || null,
      source: "manual",
      status: "new" as const,
    };
    const { data, error } = await supabase.from("outreach_contacts").insert(payload).select().single();
    setAdding(false);
    if (error) {
      toast.error(error.message || "Failed to add contact");
      return;
    }
    setContacts(prev => [data as OutreachContact, ...prev]);
    setAddOpen(false);
    resetNewContact();
    toast.success("Contact added");
  };

  // Debounce the search box so we run one query when you stop typing, not per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(0); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  // Build the FILTERED + SEARCHED query, run server-side. This is what lets us page
  // through every contact (a single select caps at 1000) and search the whole table
  // rather than only the rows already loaded. The address/agent search runs here too.
  const buildQuery = useCallback(() => {
    let q = supabase.from("outreach_contacts").select("*", { count: "exact" });
    if (audienceFilter !== "all") q = q.eq("audience_id", audienceFilter);
    if (statusFilter !== "all") q = q.eq("status", statusFilter);
    if (platformFilter !== "all") q = q.eq("platform", platformFilter);
    if (followerRange !== 0) {
      const r = FOLLOWER_RANGES[followerRange];
      q = q.gte("followers", r.min).lte("followers", r.max);
    }
    // Strip chars that would break PostgREST's or() syntax, then match across fields.
    const s = debouncedSearch.trim().replace(/[(),%*]/g, " ").trim();
    if (s) {
      const like = `%${s}%`;
      q = q.or(["name", "email", "username", "agent_name", "street_address", "city", "property_state", "property_zip"]
        .map((col) => `${col}.ilike.${like}`).join(","));
    }
    return q.order("created_at", { ascending: false });
  }, [audienceFilter, statusFilter, platformFilter, followerRange, debouncedSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    const from = page * PAGE_SIZE;
    const { data, count } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    setContacts((data as OutreachContact[]) || []);
    setTotalCount(count ?? 0);
    setLoading(false);
  }, [page, buildQuery]);

  useEffect(() => { load(); }, [load]);

  const paginated = contacts; // the server already returned exactly this page
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const openDetail = (c: OutreachContact) => {
    setDetailContact(c);
    setEditFields({
      name: c.name || "",
      email: c.email || "",
      username: c.username || "",
      platform: c.platform || "",
      followers: c.followers?.toString() || "",
      bio: c.bio || "",
      profile_url: c.profile_url || "",
      source: c.source || "",
      status: c.status || "new",
      notes: c.notes || "",
    });
  };

  const setField = (key: keyof EditFields, val: string) => setEditFields(prev => ({ ...prev, [key]: val }));

  const saveContact = async () => {
    if (!detailContact) return;
    setSaving(true);
    const platform = (editFields.platform as OutreachContact["platform"]) || null;
    const updates = {
      name: editFields.name,
      email: editFields.email,
      username: editFields.username || null,
      platform,
      followers: editFields.followers ? parseInt(editFields.followers) : null,
      bio: editFields.bio || null,
      profile_url: editFields.profile_url || null,
      source: editFields.source || null,
      status: editFields.status as OutreachContact["status"],
      notes: editFields.notes || null,
    };
    await supabase.from("outreach_contacts").update(updates).eq("id", detailContact.id);
    const updated: OutreachContact = { ...detailContact, ...updates };
    setDetailContact(updated);
    setContacts(prev => prev.map(c => c.id === detailContact.id ? updated : c));
    setSaving(false);
    toast.success("Contact saved");
  };

  const updateStatus = async (id: string, status: OutreachContact["status"]) => {
    await supabase.from("outreach_contacts").update({ status }).eq("id", id);
    setContacts(prev => prev.map(c => c.id === id ? { ...c, status } : c));
    if (detailContact?.id === id) {
      setDetailContact(prev => prev ? { ...prev, status } : null);
      setField("status", status || "new");
    }
    toast.success("Status updated");
  };

  const bulkDelete = async () => {
    if (!confirm(`Delete ${selected.size} contacts? This cannot be undone.`)) return;
    await supabase.from("outreach_contacts").delete().in("id", [...selected]);
    setSelected(new Set());
    await load(); // refresh the page + total from the server
    toast.success("Contacts deleted");
  };

  const bulkUpdateStatus = async (status: OutreachContact["status"]) => {
    await supabase.from("outreach_contacts").update({ status }).in("id", [...selected]);
    setContacts(prev => prev.map(c => selected.has(c.id) ? { ...c, status } : c));
    if (detailContact && selected.has(detailContact.id)) {
      setDetailContact(prev => prev ? { ...prev, status } : null);
    }
    setBulkStatusOpen(false);
    toast.success(`${selected.size} contacts updated to "${status}"`);
  };

  const composeToSelected = () => {
    const emails = contacts.filter(c => selected.has(c.id)).map(c => c.email);
    onCompose?.(emails);
  };

  const openDynamicPage = async (c: OutreachContact) => {
    // Reuse an existing standalone (no-campaign) preview page for this contact if it exists,
    // otherwise provision a fresh one.
    const { data: existing } = await supabase
      .from("outreach_dynamic_pages")
      .select("token")
      .eq("contact_id", c.id)
      .is("campaign_id", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let token = (existing as { token?: string } | null)?.token;

    if (!token) {
      const snapshot = {
        email: c.email,
        street_address: c.street_address,
        city: c.city,
        state: c.property_state,
        zip: c.property_zip,
        bedrooms: c.property_bedrooms,
        bathrooms: c.property_bathrooms,
        square_feet: c.property_square_feet,
        year_built: c.property_year_built,
        property_type: c.property_type,
        listing_amount: c.listing_amount,
        days_on_market: c.days_on_market,
        agent_name: c.agent_name,
        listing_image_urls: c.listing_image_urls,
      };
      const { data: created, error } = await supabase
        .from("outreach_dynamic_pages")
        .insert({
          contact_id: c.id,
          recipient_email: c.email,
          snapshot,
        })
        .select("token")
        .single();
      if (error || !created) {
        toast.error(error?.message || "Could not create preview link");
        return;
      }
      token = (created as { token: string }).token;
    }

    window.open(`/r/${token}`, "_blank", "noopener,noreferrer");
  };

  // Drop this contact's listing into the current user's workspace, in the background.
  const stageProperty = async (c: OutreachContact) => {
    setStagingId(c.id);
    try {
      const roomProjectId = await stageContactProperty(c);
      toast.success("Property added to your workspace", {
        action: { label: "Open", onClick: () => navigate(`/projects?from=re-dynamic&spotlight=${roomProjectId}`) },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not stage the property");
    } finally {
      setStagingId(null);
    }
  };

  const [exporting, setExporting] = useState(false);
  const exportCSV = async () => {
    setExporting(true);
    // Export the whole matching set (or just what's selected), pulled from the server in
    // pages — not only the contacts currently on screen.
    const rows: OutreachContact[] = [];
    try {
      if (selected.size > 0) {
        const ids = [...selected];
        for (let i = 0; i < ids.length; i += 500) {
          const { data } = await supabase.from("outreach_contacts").select("*").in("id", ids.slice(i, i + 500));
          rows.push(...((data as OutreachContact[]) || []));
        }
      } else {
        for (let from = 0; ; from += 1000) {
          const { data } = await buildQuery().range(from, from + 999);
          const chunk = (data as OutreachContact[]) || [];
          rows.push(...chunk);
          if (chunk.length < 1000) break;
        }
      }
    } finally {
      setExporting(false);
    }
    const headers = "name,username,email,followers,platform,status,source";
    const csv = [headers, ...rows.map(c => [c.name, c.username || "", c.email, c.followers || "", c.platform || "", c.status, c.source || ""].join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "outreach_contacts.csv"; a.click();
  };

  return (
    <div className="flex gap-6 h-full relative">
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {/* Filters */}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} placeholder="Search name, email, address, agent…" className="h-8 pl-8 text-sm w-64" />
          </div>
          <select value={audienceFilter} onChange={e => { setAudienceFilter(e.target.value); setPage(0); }} className="h-8 text-xs border border-input rounded-md px-2 bg-background">
            <option value="all">All audiences</option>
            {audiences.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(0); }} className="h-8 text-xs border border-input rounded-md px-2 bg-background">
            {STATUSES.map(s => <option key={s} value={s}>{s === "all" ? "All statuses" : s}</option>)}
          </select>
          <select value={platformFilter} onChange={e => { setPlatformFilter(e.target.value); setPage(0); }} className="h-8 text-xs border border-input rounded-md px-2 bg-background">
            {PLATFORMS.map(p => <option key={p} value={p}>{p === "all" ? "All platforms" : PLATFORM_ICONS[p]?.label || p}</option>)}
          </select>
          <select value={followerRange} onChange={e => { setFollowerRange(Number(e.target.value)); setPage(0); }} className="h-8 text-xs border border-input rounded-md px-2 bg-background">
            {FOLLOWER_RANGES.map((r, i) => <option key={i} value={i}>{r.label}</option>)}
          </select>
          <span className="text-xs text-muted-foreground ml-auto">{totalCount.toLocaleString()} contact{totalCount === 1 ? "" : "s"}</span>
          <Button size="sm" onClick={() => setAddOpen(true)} className="h-8 text-xs gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Add contact
          </Button>
          <Button size="sm" variant="outline" onClick={exportCSV} disabled={exporting} className="h-8 text-xs">{exporting ? "Exporting…" : "Export CSV"}</Button>
        </div>

        {/* Add contact dialog */}
        <Dialog open={addOpen} onOpenChange={(o) => { setAddOpen(o); if (!o) resetNewContact(); }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Add new contact</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="text-xs text-muted-foreground mb-1 block">Name *</label>
                <Input value={newContact.name} onChange={e => setNewContact(p => ({ ...p, name: e.target.value }))} placeholder="Full name" />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-muted-foreground mb-1 block">Email *</label>
                <Input type="email" value={newContact.email} onChange={e => setNewContact(p => ({ ...p, email: e.target.value }))} placeholder="email@example.com" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Username</label>
                <Input value={newContact.username} onChange={e => setNewContact(p => ({ ...p, username: e.target.value }))} placeholder="@handle" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Followers</label>
                <Input type="number" value={newContact.followers} onChange={e => setNewContact(p => ({ ...p, followers: e.target.value }))} placeholder="0" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Platform</label>
                <select value={newContact.platform} onChange={e => setNewContact(p => ({ ...p, platform: e.target.value }))} className="w-full h-10 text-sm border border-input rounded-md px-2 bg-background">
                  <option value="">None</option>
                  {PLATFORMS.filter(p => p !== "all").map(p => <option key={p} value={p}>{PLATFORM_ICONS[p]?.label || p}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Audience</label>
                <select value={newContact.audience_id} onChange={e => setNewContact(p => ({ ...p, audience_id: e.target.value }))} className="w-full h-10 text-sm border border-input rounded-md px-2 bg-background">
                  <option value="">None</option>
                  {audiences.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="text-xs text-muted-foreground mb-1 block">Profile URL</label>
                <Input value={newContact.profile_url} onChange={e => setNewContact(p => ({ ...p, profile_url: e.target.value }))} placeholder="https://instagram.com/..." />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-muted-foreground mb-1 block">Notes</label>
                <Textarea value={newContact.notes} onChange={e => setNewContact(p => ({ ...p, notes: e.target.value }))} rows={3} placeholder="Optional notes" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button onClick={createContact} disabled={adding}>{adding ? "Adding…" : "Add contact"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 bg-muted/40 border border-border rounded-lg px-4 py-2 flex-wrap">
            <span className="text-sm font-medium text-foreground">{selected.size} selected</span>
            {/* Bulk status */}
            <div className="relative">
              <button
                onClick={() => setBulkStatusOpen(v => !v)}
                className="flex items-center gap-1.5 h-7 text-xs px-2.5 rounded-md border border-border bg-background hover:bg-muted/60 transition-colors">
                Set status <ChevronDown className="w-3 h-3" />
              </button>
              {bulkStatusOpen && (
                <div className="absolute left-0 top-full mt-1 z-20 bg-card border border-border rounded-lg min-w-[140px] py-1">
                  {(["new", "contacted", "replied", "partner", "rejected", "unsubscribed"] as OutreachContact["status"][]).map(s => (
                    <button key={s} onClick={() => bulkUpdateStatus(s)}
                      className="w-full text-left text-xs px-3 py-2 hover:bg-muted/60 transition-colors text-foreground capitalize">
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Compose */}
            {onCompose && (
              <Button size="sm" variant="outline" onClick={composeToSelected} className="h-7 text-xs gap-1.5">
                <Mail className="w-3 h-3" /> Compose to {selected.size}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={bulkDelete} className="h-7 text-xs text-destructive border-destructive/30">
              <Trash2 className="w-3 h-3 mr-1" /> Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} className="h-7 text-xs ml-auto">Clear</Button>
          </div>
        )}

        {/* Table */}
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" checked={selected.size === paginated.length && paginated.length > 0}
                    onChange={e => setSelected(e.target.checked ? new Set(paginated.map(c => c.id)) : new Set())}
                    className="rounded" />
                </th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Name</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Email</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Platform</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Followers</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Status</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Last Contact</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="text-center py-8 text-muted-foreground text-sm">Loading…</td></tr>
              ) : paginated.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-8 text-muted-foreground text-sm">No contacts match filters</td></tr>
              ) : paginated.map(c => (
                <tr key={c.id} className={cn(
                  "border-b border-border/50 last:border-0 cursor-pointer transition-colors",
                  detailContact?.id === c.id ? "bg-primary/5" : selected.has(c.id) ? "bg-muted/40" : "hover:bg-muted/20"
                )} onClick={() => openDetail(c)}>
                  <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} className="rounded" />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground flex-shrink-0">
                        {c.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="text-xs font-medium text-foreground">{c.name}</p>
                        {c.username && <p className="text-xs text-muted-foreground">@{c.username}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{c.email}</td>
                  <td className="px-3 py-2.5">
                    {c.platform && <span className="text-xs text-muted-foreground">{PLATFORM_ICONS[c.platform]?.label}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{formatFollowers(c.followers)}</td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground capitalize">
                      <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", STATUS_DOT[c.status] || "bg-muted-foreground/40")} />
                      {c.status}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {c.last_contacted_at ? new Date(c.last_contacted_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                    <div className="flex gap-1 items-center">
                      <button
                        onClick={(e) => { e.stopPropagation(); openDynamicPage(c); }}
                        title="Open dynamic page"
                        className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors">
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      {c.profile_url && (
                        <a href={c.profile_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                          className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors">
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Page {page + 1} of {totalPages}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="h-7 w-7 p-0">
                <ChevronLeft className="w-3 h-3" />
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="h-7 w-7 p-0">
                <ChevronRight className="w-3 h-3" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Contact detail panel */}
      {detailContact && (
        <div className="w-80 flex-shrink-0 border border-border rounded-xl p-4 bg-card h-fit sticky top-0 flex flex-col gap-3 overflow-y-auto max-h-[80vh]">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-medium text-foreground text-sm">{detailContact.name}</h3>
              {detailContact.username && <p className="text-xs text-muted-foreground">@{detailContact.username}</p>}
            </div>
            <button onClick={() => setDetailContact(null)} className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors flex-shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Name</p>
              <Input value={editFields.name} onChange={e => setField("name", e.target.value)} className="h-7 text-xs" placeholder="Full name" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Username</p>
              <Input value={editFields.username} onChange={e => setField("username", e.target.value)} className="h-7 text-xs" placeholder="@handle" />
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Email</p>
            <Input value={editFields.email} onChange={e => setField("email", e.target.value)} className="h-7 text-xs" placeholder="email@example.com" type="email" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Platform</p>
              <select value={editFields.platform} onChange={e => setField("platform", e.target.value)} className="w-full h-7 text-xs border border-input rounded-md px-2 bg-background">
                <option value="">None</option>
                {(["instagram", "tiktok", "youtube", "twitter", "other"] as const).map(p => (
                  <option key={p} value={p}>{PLATFORM_ICONS[p]?.label || p}</option>
                ))}
              </select>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Followers</p>
              <Input value={editFields.followers} onChange={e => setField("followers", e.target.value)} className="h-7 text-xs" placeholder="e.g. 50000" type="number" />
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Status</p>
            <select value={editFields.status} onChange={e => setField("status", e.target.value)} className="w-full h-7 text-xs border border-input rounded-md px-2 bg-background">
              {["new", "contacted", "replied", "partner", "rejected", "unsubscribed"].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Profile URL</p>
            <div className="flex gap-1">
              <Input value={editFields.profile_url} onChange={e => setField("profile_url", e.target.value)} className="h-7 text-xs flex-1" placeholder="https://..." />
              {editFields.profile_url && (
                <a href={editFields.profile_url} target="_blank" rel="noreferrer" className="h-7 w-7 flex items-center justify-center border border-border rounded-md text-muted-foreground hover:text-foreground flex-shrink-0">
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Source</p>
            <Input value={editFields.source} onChange={e => setField("source", e.target.value)} className="h-7 text-xs" placeholder="Where did you find them?" />
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Bio</p>
            <Textarea value={editFields.bio} onChange={e => setField("bio", e.target.value)} placeholder="Bio…" className="text-xs min-h-[60px] resize-none" />
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Notes</p>
            <Textarea value={editFields.notes} onChange={e => setField("notes", e.target.value)} placeholder="Private notes…" className="text-xs min-h-[60px] resize-none" />
          </div>


          {/* Real-estate listing details (read-only preview) */}
          {(detailContact.street_address || detailContact.listing_amount || (detailContact.listing_image_urls && detailContact.listing_image_urls.length > 0) || detailContact.agent_name) && (
            <div className="border-t border-border/60 pt-3 mt-1 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
                  <Home className="w-3 h-3" /> Listing
                </p>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" onClick={() => stageProperty(detailContact)} disabled={stagingId === detailContact.id} className="h-7 text-[11px] gap-1" title="Add this property's rooms to your workspace">
                    <Wand2 className="w-3 h-3" /> {stagingId === detailContact.id ? "Adding…" : "Stage"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openDynamicPage(detailContact)} className="h-7 text-[11px] gap-1">
                    <Eye className="w-3 h-3" /> Page
                  </Button>
                </div>
              </div>

              {detailContact.listing_image_urls && detailContact.listing_image_urls.length > 0 && (
                <div className="grid grid-cols-3 gap-1">
                  {detailContact.listing_image_urls.slice(0, 6).map((url, i) => (
                    <a key={i} href={url} target="_blank" rel="noreferrer" className="aspect-square rounded overflow-hidden bg-muted block">
                      <img src={url} alt={`listing ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
                    </a>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
                {detailContact.street_address && (
                  <div className="col-span-2"><span className="text-muted-foreground">Address: </span><span className="text-foreground">{detailContact.street_address}{detailContact.city ? `, ${detailContact.city}` : ""}{detailContact.property_state ? `, ${detailContact.property_state}` : ""} {detailContact.property_zip || ""}</span></div>
                )}
                {detailContact.listing_amount != null && (
                  <div><span className="text-muted-foreground">Price: </span><span className="text-foreground">${detailContact.listing_amount.toLocaleString()}</span></div>
                )}
                {detailContact.price_per_square_foot != null && (
                  <div><span className="text-muted-foreground">$/sqft: </span><span className="text-foreground">${detailContact.price_per_square_foot}</span></div>
                )}
                {detailContact.property_bedrooms != null && (
                  <div><span className="text-muted-foreground">Beds: </span><span className="text-foreground">{detailContact.property_bedrooms}</span></div>
                )}
                {detailContact.property_bathrooms != null && (
                  <div><span className="text-muted-foreground">Baths: </span><span className="text-foreground">{detailContact.property_bathrooms}</span></div>
                )}
                {detailContact.property_square_feet != null && (
                  <div><span className="text-muted-foreground">Sq ft: </span><span className="text-foreground">{detailContact.property_square_feet.toLocaleString()}</span></div>
                )}
                {detailContact.property_year_built != null && (
                  <div><span className="text-muted-foreground">Built: </span><span className="text-foreground">{detailContact.property_year_built}</span></div>
                )}
                {detailContact.property_type && (
                  <div className="col-span-2"><span className="text-muted-foreground">Type: </span><span className="text-foreground">{detailContact.property_type}</span></div>
                )}
                {detailContact.days_on_market != null && (
                  <div><span className="text-muted-foreground">DOM: </span><span className="text-foreground">{detailContact.days_on_market}</span></div>
                )}
                {detailContact.mls_listing_id && (
                  <div><span className="text-muted-foreground">MLS: </span><span className="text-foreground">{detailContact.mls_listing_id}</span></div>
                )}
                {detailContact.agent_name && (
                  <div className="col-span-2 mt-1"><span className="text-muted-foreground">Agent: </span><span className="text-foreground">{detailContact.agent_name}</span>{detailContact.agent_phone ? <span className="text-muted-foreground"> · {detailContact.agent_phone}</span> : null}</div>
                )}
                {detailContact.office_name && (
                  <div className="col-span-2"><span className="text-muted-foreground">Office: </span><span className="text-foreground">{detailContact.office_name}</span></div>
                )}
              </div>
            </div>
          )}

          <Button size="sm" variant="outline" onClick={saveContact} disabled={saving} className="h-8 text-xs gap-1.5 w-full mt-1">
            <Save className="w-3 h-3" /> {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </div>
  );
}
