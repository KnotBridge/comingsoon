import { useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { OutreachAudience, OutreachContact } from "./types";
import { Search, ChevronLeft, ChevronRight, Mail, Trash2, ExternalLink, X, ChevronDown, Save, Plus, MapPin, Globe, Phone, Star } from "lucide-react";
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
const STATUSES = ["all", "new", "contacted", "replied", "interested", "customer", "rejected", "unsubscribed"] as const;
const EDIT_STATUSES = ["new", "contacted", "replied", "interested", "customer", "rejected", "unsubscribed"] as const;

// Quiet status dots — a status is a word, not a filled pill.
const STATUS_DOT: Record<string, string> = {
  new: "bg-muted-foreground/40",
  contacted: "bg-amber-400",
  replied: "bg-emerald-500",
  interested: "bg-primary",
  customer: "bg-emerald-600",
  rejected: "bg-rose-400",
  unsubscribed: "bg-muted-foreground/30",
};

type EditFields = {
  name: string;
  email: string;
  category: string;
  phone: string;
  website: string;
  city: string;
  state: string;
  source: string;
  status: string;
  notes: string;
};

const cat = (c: OutreachContact) => c.primary_category || (Array.isArray(c.categories) ? c.categories[0] : "") || "";

export default function ContactsPage({ audiences, onCompose }: Props) {
  const [contacts, setContacts] = useState<OutreachContact[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [audienceFilter, setAudienceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailContact, setDetailContact] = useState<OutreachContact | null>(null);
  const [editFields, setEditFields] = useState<EditFields>({ name: "", email: "", category: "", phone: "", website: "", city: "", state: "", source: "", status: "new", notes: "" });
  const [saving, setSaving] = useState(false);
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newContact, setNewContact] = useState({ name: "", email: "", category: "", phone: "", website: "", city: "", audience_id: "", notes: "" });

  const resetNewContact = () => setNewContact({ name: "", email: "", category: "", phone: "", website: "", city: "", audience_id: "", notes: "" });

  const createContact = async () => {
    if (!newContact.name.trim() || !newContact.email.trim()) {
      toast.error("Business name and email are required");
      return;
    }
    setAdding(true);
    const payload = {
      name: newContact.name.trim(),
      email: newContact.email.trim().toLowerCase(),
      primary_category: newContact.category.trim() || null,
      phone: newContact.phone.trim() || null,
      website_url: newContact.website.trim() || null,
      city: newContact.city.trim() || null,
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

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(0); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  // Server-side filtered + searched query so we can page through the whole table.
  const buildQuery = useCallback(() => {
    let q = supabase.from("outreach_contacts").select("*", { count: "exact" });
    if (audienceFilter !== "all") q = q.eq("audience_id", audienceFilter);
    if (statusFilter !== "all") q = q.eq("status", statusFilter);
    const s = debouncedSearch.trim().replace(/[(),%*]/g, " ").trim();
    if (s) {
      const like = `%${s}%`;
      q = q.or(["name", "email", "phone", "city", "state", "primary_category", "domain"]
        .map((col) => `${col}.ilike.${like}`).join(","));
    }
    return q.order("created_at", { ascending: false });
  }, [audienceFilter, statusFilter, debouncedSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    const from = page * PAGE_SIZE;
    const { data, count } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    setContacts((data as OutreachContact[]) || []);
    setTotalCount(count ?? 0);
    setLoading(false);
  }, [page, buildQuery]);

  useEffect(() => { load(); }, [load]);

  const paginated = contacts;
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
      category: cat(c),
      phone: c.phone || "",
      website: c.website_url || "",
      city: c.city || "",
      state: c.state || "",
      source: c.source || "",
      status: c.status || "new",
      notes: c.notes || "",
    });
  };

  const setField = (key: keyof EditFields, val: string) => setEditFields(prev => ({ ...prev, [key]: val }));

  const saveContact = async () => {
    if (!detailContact) return;
    setSaving(true);
    const updates = {
      name: editFields.name,
      email: editFields.email,
      primary_category: editFields.category || null,
      phone: editFields.phone || null,
      website_url: editFields.website || null,
      city: editFields.city || null,
      state: editFields.state || null,
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

  const bulkDelete = async () => {
    if (!confirm(`Delete ${selected.size} contacts? This cannot be undone.`)) return;
    await supabase.from("outreach_contacts").delete().in("id", [...selected]);
    setSelected(new Set());
    await load();
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

  const [exporting, setExporting] = useState(false);
  const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const exportCSV = async () => {
    setExporting(true);
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
    const headers = ["name", "email", "category", "phone", "website", "city", "state", "rating", "reviews", "status", "source"];
    const csv = [headers.join(","), ...rows.map(c => [
      c.name, c.email, cat(c), c.phone || "", c.website_url || "", c.city || "", c.state || "",
      c.rating ?? "", c.review_count ?? "", c.status, c.source || "",
    ].map(csvCell).join(","))].join("\n");
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
            <Input value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} placeholder="Search name, email, city, category…" className="h-8 pl-8 text-sm w-64" />
          </div>
          <select value={audienceFilter} onChange={e => { setAudienceFilter(e.target.value); setPage(0); }} className="h-8 text-xs border border-input rounded-md px-2 bg-background">
            <option value="all">All audiences</option>
            {audiences.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(0); }} className="h-8 text-xs border border-input rounded-md px-2 bg-background">
            {STATUSES.map(s => <option key={s} value={s}>{s === "all" ? "All statuses" : s}</option>)}
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
                <label className="text-xs text-muted-foreground mb-1 block">Business name *</label>
                <Input value={newContact.name} onChange={e => setNewContact(p => ({ ...p, name: e.target.value }))} placeholder="Glow Med Spa" />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-muted-foreground mb-1 block">Email *</label>
                <Input type="email" value={newContact.email} onChange={e => setNewContact(p => ({ ...p, email: e.target.value }))} placeholder="hello@business.com" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Category</label>
                <Input value={newContact.category} onChange={e => setNewContact(p => ({ ...p, category: e.target.value }))} placeholder="Medical spa" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Phone</label>
                <Input value={newContact.phone} onChange={e => setNewContact(p => ({ ...p, phone: e.target.value }))} placeholder="(512) 555-0142" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Website</label>
                <Input value={newContact.website} onChange={e => setNewContact(p => ({ ...p, website: e.target.value }))} placeholder="business.com" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">City</label>
                <Input value={newContact.city} onChange={e => setNewContact(p => ({ ...p, city: e.target.value }))} placeholder="Austin" />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-muted-foreground mb-1 block">Audience</label>
                <select value={newContact.audience_id} onChange={e => setNewContact(p => ({ ...p, audience_id: e.target.value }))} className="w-full h-10 text-sm border border-input rounded-md px-2 bg-background">
                  <option value="">None</option>
                  {audiences.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
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
            <div className="relative">
              <button
                onClick={() => setBulkStatusOpen(v => !v)}
                className="flex items-center gap-1.5 h-7 text-xs px-2.5 rounded-md border border-border bg-background hover:bg-muted/60 transition-colors">
                Set status <ChevronDown className="w-3 h-3" />
              </button>
              {bulkStatusOpen && (
                <div className="absolute left-0 top-full mt-1 z-20 bg-card border border-border rounded-lg min-w-[140px] py-1">
                  {EDIT_STATUSES.map(s => (
                    <button key={s} onClick={() => bulkUpdateStatus(s)}
                      className="w-full text-left text-xs px-3 py-2 hover:bg-muted/60 transition-colors text-foreground capitalize">
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Business</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Email</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Category</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">City</th>
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
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground truncate">{c.name}</p>
                        {c.rating != null && (
                          <p className="text-xs text-muted-foreground flex items-center gap-0.5">
                            <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400" /> {c.rating}{c.review_count != null ? ` (${c.review_count})` : ""}
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{c.email}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{cat(c) || "—"}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{c.city || "—"}</td>
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
                      {c.website_url && (
                        <a href={/^https?:\/\//.test(c.website_url) ? c.website_url : `https://${c.website_url}`} target="_blank" rel="noreferrer"
                          title="Website"
                          className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors">
                          <Globe className="w-3.5 h-3.5" />
                        </a>
                      )}
                      {c.maps_url && (
                        <a href={c.maps_url} target="_blank" rel="noreferrer" title="Google Maps"
                          className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors">
                          <MapPin className="w-3.5 h-3.5" />
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
            <div className="min-w-0">
              <h3 className="font-medium text-foreground text-sm truncate">{detailContact.name}</h3>
              {detailContact.rating != null && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Star className="w-3 h-3 fill-amber-400 text-amber-400" /> {detailContact.rating}
                  {detailContact.review_count != null ? ` · ${detailContact.review_count} reviews` : ""}
                </p>
              )}
            </div>
            <button onClick={() => setDetailContact(null)} className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors flex-shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Business name</p>
            <Input value={editFields.name} onChange={e => setField("name", e.target.value)} className="h-7 text-xs" placeholder="Business name" />
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Email</p>
            <Input value={editFields.email} onChange={e => setField("email", e.target.value)} className="h-7 text-xs" placeholder="email@business.com" type="email" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Category</p>
              <Input value={editFields.category} onChange={e => setField("category", e.target.value)} className="h-7 text-xs" placeholder="Medical spa" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Phone</p>
              <Input value={editFields.phone} onChange={e => setField("phone", e.target.value)} className="h-7 text-xs" placeholder="(555) 555-5555" />
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Website</p>
            <div className="flex gap-1">
              <Input value={editFields.website} onChange={e => setField("website", e.target.value)} className="h-7 text-xs flex-1" placeholder="business.com" />
              {editFields.website && (
                <a href={/^https?:\/\//.test(editFields.website) ? editFields.website : `https://${editFields.website}`} target="_blank" rel="noreferrer" className="h-7 w-7 flex items-center justify-center border border-border rounded-md text-muted-foreground hover:text-foreground flex-shrink-0">
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="text-xs text-muted-foreground mb-1">City</p>
              <Input value={editFields.city} onChange={e => setField("city", e.target.value)} className="h-7 text-xs" placeholder="Austin" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">State</p>
              <Input value={editFields.state} onChange={e => setField("state", e.target.value)} className="h-7 text-xs" placeholder="TX" />
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Status</p>
            <select value={editFields.status} onChange={e => setField("status", e.target.value)} className="w-full h-7 text-xs border border-input rounded-md px-2 bg-background">
              {EDIT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Source</p>
            <Input value={editFields.source} onChange={e => setField("source", e.target.value)} className="h-7 text-xs" placeholder="Where did you find them?" />
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Notes</p>
            <Textarea value={editFields.notes} onChange={e => setField("notes", e.target.value)} placeholder="Private notes…" className="text-xs min-h-[60px] resize-none" />
          </div>

          {(detailContact.address || detailContact.maps_url) && (
            <div className="border-t border-border/60 pt-3 space-y-1.5 text-[11px]">
              {detailContact.address && (
                <div className="flex gap-1.5 text-muted-foreground">
                  <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0" />
                  <span>{detailContact.address}{detailContact.city ? `, ${detailContact.city}` : ""}{detailContact.state ? `, ${detailContact.state}` : ""} {detailContact.postal_code || ""}</span>
                </div>
              )}
              {detailContact.phone && (
                <div className="flex gap-1.5 text-muted-foreground"><Phone className="w-3 h-3 flex-shrink-0" /><span>{detailContact.phone}</span></div>
              )}
              {detailContact.maps_url && (
                <a href={detailContact.maps_url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                  <ExternalLink className="w-3 h-3" /> View on Google Maps
                </a>
              )}
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
