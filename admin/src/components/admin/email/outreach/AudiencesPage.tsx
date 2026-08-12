import { useState, useCallback, useEffect } from "react";
import Papa from "papaparse";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { OutreachAudience, OutreachContact } from "./types";
import { mapImportedContact } from "./types";
import { formatFollowers, PLATFORM_ICONS } from "./types";
import { Users, Plus, Upload, Search, ChevronRight, Trash2, X, Check, ShieldCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { verifyEmails, summarize, type EmailVerdict } from "./emailVerify";

const VERDICT_LABEL: Record<EmailVerdict, string> = {
  valid: "Deliverable", invalid_syntax: "Bad format", no_mx: "Dead domain",
  disposable: "Disposable", role: "Role address", typo: "Likely typo",
};

// Quiet status dots — a status is a word, not a filled pill. One small dot per
// state, everything else stays muted grey text.
const STATUS_DOT: Record<string, string> = {
  new: "bg-blue-500",
  contacted: "bg-amber-500",
  replied: "bg-emerald-500",
  partner: "bg-violet-500",
  rejected: "bg-red-500",
  unsubscribed: "bg-muted-foreground/40",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Last-resort email finder: if the named email column wasn't recognised, scan
// every cell in the row for something that looks like an email. Catches files
// whose email header is named oddly (owner_email, contact, mail, etc.).
function findEmailInRow(raw: Record<string, unknown>): string {
  for (const v of Object.values(raw)) {
    const s = String(v ?? "").trim();
    if (EMAIL_RE.test(s)) return s.toLowerCase();
  }
  return "";
}

interface Props {
  audiences: OutreachAudience[];
  onRefresh: () => void;
}

const STATUS_FILTERS = ["all", "new", "contacted", "replied", "partner", "rejected"] as const;

export default function AudiencesPage({ audiences, onRefresh }: Props) {
  const [selectedAudience, setSelectedAudience] = useState<OutreachAudience | null>(null);
  const [contacts, setContacts] = useState<OutreachContact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showNewAudience, setShowNewAudience] = useState(false);
  const [newAudienceName, setNewAudienceName] = useState("");
  const [newAudienceDesc, setNewAudienceDesc] = useState("");
  const [importPreview, setImportPreview] = useState<Partial<OutreachContact>[] | null>(null);
  const [importSkipped, setImportSkipped] = useState<{ row: number; reason: string; preview: string }[]>([]);
  const [importing, setImporting] = useState(false);
  // Per-audience count of contacts that have actually been emailed (the sender
  // stamps last_contacted_at on every send, flow OR Compose), so this tells you
  // which audiences were already contacted and which are still fresh.
  const [contactedByAudience, setContactedByAudience] = useState<Record<string, number>>({});
  // Stable key so refetches that recreate the audiences array (same data, new
  // reference) don't re-fire the whole count repeatedly.
  const audienceKey = audiences.map((a) => a.id).join(",");

  const recomputeContacted = useCallback(async () => {
    if (!audienceKey) { setContactedByAudience({}); return; }
    // One paged pass: pull the audience_id of every already-contacted contact and
    // tally client-side (instead of N HEAD counts, one per audience).
    const counts: Record<string, number> = {};
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase.from("outreach_contacts")
        .select("audience_id")
        .not("last_contacted_at", "is", null).not("audience_id", "is", null)
        .range(from, from + 999);
      const rows = (data as { audience_id: string }[]) || [];
      for (const r of rows) counts[r.audience_id] = (counts[r.audience_id] || 0) + 1;
      if (rows.length < 1000) break;
    }
    setContactedByAudience(counts);
  }, [audienceKey]);

  useEffect(() => { recomputeContacted(); }, [recomputeContacted]);

  // Sends finish asynchronously (the queue drains minutes later), so refresh the
  // counts when the user returns to the tab.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") recomputeContacted(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [recomputeContacted]);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualForm, setManualForm] = useState({ name: "", email: "", username: "", followers: "", platform: "other", bio: "" });
  // Audience deletion asks whether to also delete the contacts in it (cascade) or
  // keep them (just unassign). null = no delete pending.
  const [audienceToDelete, setAudienceToDelete] = useState<OutreachAudience | null>(null);
  const [deletingAudienceBusy, setDeletingAudienceBusy] = useState(false);
  // Free list verification: syntax + dead domain + disposable + role + typo.
  const [verifying, setVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState<{ done: number; total: number } | null>(null);
  const [verifyReport, setVerifyReport] = useState<{ summary: Record<EmailVerdict, number>; blocked: number; total: number } | null>(null);

  const loadContacts = useCallback(async (audience: OutreachAudience) => {
    setLoadingContacts(true);
    // Page through the WHOLE audience. Supabase caps a single request at 1000 rows,
    // so without this an audience over 1000 contacts looked limited to 1000.
    const all: OutreachContact[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data } = await supabase
        .from("outreach_contacts")
        .select("*")
        .eq("audience_id", audience.id)
        .order("created_at", { ascending: false })
        .range(from, from + PAGE - 1);
      const rows = (data as OutreachContact[]) || [];
      all.push(...rows);
      if (rows.length < PAGE) break;
    }
    setContacts(all);
    setLoadingContacts(false);
  }, []);

  const selectAudience = (a: OutreachAudience) => {
    setSelectedAudience(a);
    loadContacts(a);
    setImportPreview(null);
    setVerifyReport(null);
  };

  // Verify the loaded audience for free (no API): bad addresses that will bounce go on
  // the email_blacklist, which the sender already skips. Role/typo are flagged only.
  const verifyList = async () => {
    if (!selectedAudience || contacts.length === 0) return;
    setVerifying(true); setVerifyReport(null); setVerifyProgress({ done: 0, total: 0 });
    try {
      const checks = await verifyEmails(contacts.map((c) => c.email), (done, total) => setVerifyProgress({ done, total }));
      const blockable = checks.filter((c) => c.block);
      if (blockable.length > 0) {
        const rows = blockable.map((c) => ({ email: c.email, reason: c.verdict }));
        for (let i = 0; i < rows.length; i += 200) {
          const { error } = await supabase.from("email_blacklist" as any).upsert(rows.slice(i, i + 200), { onConflict: "email", ignoreDuplicates: true });
          if (error) throw error;
        }
      }
      setVerifyReport({ summary: summarize(checks), blocked: blockable.length, total: checks.length });
      toast.success(`Verified ${checks.length} — ${blockable.length} bad address${blockable.length === 1 ? "" : "es"} blocked from sending`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setVerifying(false); setVerifyProgress(null);
    }
  };

  const createAudience = async () => {
    if (!newAudienceName.trim()) return;
    const { error } = await supabase.from("outreach_audiences").insert({
      name: newAudienceName.trim(),
      description: newAudienceDesc.trim() || null,
    });
    if (error) { toast.error("Failed to create audience"); return; }
    toast.success("Audience created");
    setShowNewAudience(false);
    setNewAudienceName("");
    setNewAudienceDesc("");
    onRefresh();
  };

  // Delete the audience, and either keep its contacts (just unassign) or delete them
  // too. When keeping, we null out audience_id so they don't dangle on a deleted row.
  const confirmDeleteAudience = async (withContacts: boolean) => {
    if (!audienceToDelete) return;
    const id = audienceToDelete.id;
    setDeletingAudienceBusy(true);
    try {
      if (withContacts) {
        const { error: cErr } = await supabase.from("outreach_contacts").delete().eq("audience_id", id);
        if (cErr) throw cErr;
      } else {
        const { error: uErr } = await supabase.from("outreach_contacts").update({ audience_id: null }).eq("audience_id", id);
        if (uErr) throw uErr;
      }
      const { error } = await supabase.from("outreach_audiences").delete().eq("id", id);
      if (error) throw error;
      if (selectedAudience?.id === id) { setSelectedAudience(null); setContacts([]); }
      toast.success(withContacts ? "Audience and its contacts deleted" : "Audience deleted, contacts kept");
      setAudienceToDelete(null);
      onRefresh();
      recomputeContacted();
    } catch (e: unknown) {
      toast.error("Delete failed: " + (e instanceof Error ? e.message : "error"));
    } finally {
      setDeletingAudienceBusy(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedAudience) return;
    e.target.value = "";

    try {
      const text = await file.text();
      let rows: Record<string, unknown>[] = [];

      if (file.name.endsWith(".json")) {
        const parsed = JSON.parse(text);
        rows = Array.isArray(parsed) ? parsed : [parsed];
      } else {
        // Papa handles quoted fields, commas inside values (addresses!), CR/LF and
        // BOM — the old naive split(",") corrupted any row with a comma in a field.
        const res = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: "greedy" });
        rows = res.data || [];
      }

      const nameFromEmail = (email: string) => {
        const local = email.split("@")[0] || "";
        const parts = local.split(/[._\-+]/).filter(p => p && !/^\d+$/.test(p));
        if (parts.length === 0) return local;
        return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
      };

      const valid: Partial<OutreachContact>[] = [];
      const skipped: { row: number; reason: string; preview: string }[] = [];
      const seen = new Set<string>();

      rows.forEach((raw, idx) => {
        const rowNo = idx + 1; // 1-based, header excluded
        const cells = Object.values(raw).map(v => String(v ?? "").trim());
        const preview = cells.filter(Boolean).join(", ").slice(0, 80);

        const c = mapImportedContact(raw);
        let email = (c.email || "").trim().toLowerCase();
        if (!email) email = findEmailInRow(raw); // fallback: oddly-named email column

        if (!email) { skipped.push({ row: rowNo, reason: "No email address in this row", preview }); return; }
        if (!EMAIL_RE.test(email)) { skipped.push({ row: rowNo, reason: `Email looks invalid: "${email}"`, preview }); return; }
        if (seen.has(email)) { skipped.push({ row: rowNo, reason: `Duplicate of an earlier row (${email})`, preview }); return; }
        seen.add(email);

        valid.push({ ...c, email, name: (c.name && c.name.trim()) || nameFromEmail(email) || c.username || "Unknown" });
      });

      if (valid.length === 0 && skipped.length === 0) { toast.error("No rows found in file"); return; }
      setImportPreview(valid);
      setImportSkipped(skipped);
      if (skipped.length > 0) toast.warning(`${valid.length} ready, ${skipped.length} skipped — see why below`);
    } catch {
      toast.error("Failed to parse file");
    }
  };

  const confirmImport = async () => {
    if (!importPreview || !selectedAudience) return;
    setImporting(true);
    const targetId = selectedAudience.id;
    const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

    try {
      // De-dupe the incoming file by email (keep the last occurrence).
      const byEmail = new Map<string, Partial<OutreachContact>>();
      for (const c of importPreview) if (c.email) byEmail.set(c.email, c);
      const incoming = [...byEmail.values()];

      // Look up existing contacts by email (email is globally unique → one row each).
      const emails = incoming.map(c => c.email!);
      const existing = new Map<string, { id: string; street_address: string | null; audience_id: string | null }>();
      for (let i = 0; i < emails.length; i += 300) {
        const { data } = await supabase.from("outreach_contacts")
          .select("id,email,street_address,audience_id").in("email", emails.slice(i, i + 300));
        for (const r of (data as any[]) || []) existing.set(r.email, r);
      }

      const toInsert: any[] = [];
      const toUpdate: { id: string; data: any }[] = [];
      const affected = new Set<string>([targetId]);
      let added = 0, moved = 0, updated = 0, skipped = 0;

      for (const c of incoming) {
        const ex = existing.get(c.email!);
        if (!ex) {
          // Brand new contact → add to the target audience.
          toInsert.push({ ...c, email: c.email!, name: c.name!, audience_id: targetId });
          added++;
          continue;
        }
        const newAddr = norm(c.street_address);
        const oldAddr = norm(ex.street_address);
        if (newAddr && newAddr !== oldAddr) {
          // New listing → update the contact and move it into this audience
          // (which removes it from its old one). Keep the same row/id, and keep
          // its status (don't reset an already-contacted agent back to "new").
          const { id: _i, audience_id: _a, status: _s, ...fields } = c as any;
          toUpdate.push({ id: ex.id, data: { ...fields, name: c.name!, audience_id: targetId } });
          if (ex.audience_id && ex.audience_id !== targetId) { affected.add(ex.audience_id); moved++; }
          else updated++;
        } else {
          // Already exists with the same listing → skip.
          skipped++;
        }
      }

      for (let i = 0; i < toInsert.length; i += 300) {
        const { error } = await supabase.from("outreach_contacts").insert(toInsert.slice(i, i + 300));
        if (error) throw error;
      }
      for (const u of toUpdate) {
        const { error } = await supabase.from("outreach_contacts").update(u.data).eq("id", u.id);
        if (error) throw error;
      }

      // Recompute contact_count for the target + any audiences we moved contacts out of.
      for (const aid of affected) {
        const { count } = await supabase.from("outreach_contacts").select("id", { count: "exact", head: true }).eq("audience_id", aid);
        await supabase.from("outreach_audiences").update({ contact_count: count || 0 }).eq("id", aid);
      }

      toast.success(`${added} added · ${moved} moved here · ${updated} updated · ${skipped} skipped (same listing)`);
      setImportPreview(null);
      setImportSkipped([]);
      loadContacts(selectedAudience);
      onRefresh();
    } catch (err: any) {
      toast.error("Import failed: " + (err?.message || "error"));
    } finally {
      setImporting(false);
    }
  };

  const addManualContact = async () => {
    if (!manualForm.name || !manualForm.email || !selectedAudience) return;
    const { error } = await supabase.from("outreach_contacts").insert({
      audience_id: selectedAudience.id,
      name: manualForm.name,
      email: manualForm.email,
      username: manualForm.username || null,
      followers: manualForm.followers ? parseInt(manualForm.followers) : null,
      platform: manualForm.platform as OutreachContact["platform"],
      bio: manualForm.bio || null,
    });
    if (error) {
      toast.error(error.message.includes("unique") ? "Email already exists" : "Failed to add contact");
      return;
    }
    toast.success("Contact added");
    setManualForm({ name: "", email: "", username: "", followers: "", platform: "other", bio: "" });
    setShowManualAdd(false);
    loadContacts(selectedAudience);
    onRefresh();
  };

  const filteredContacts = contacts.filter(c => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q) || (c.username || "").toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="flex gap-6 h-full min-h-0 w-full">
      {/* Left: Audiences list — its own scroll, independent of the contacts table */}
      <div className="w-72 flex-shrink-0 flex flex-col gap-3 min-h-0">
        <div className="flex items-center justify-between shrink-0">
          <h3 className="font-medium text-foreground">Audiences</h3>
          <Button size="sm" variant="outline" onClick={() => setShowNewAudience(true)} className="gap-1.5">
            <Plus className="w-3.5 h-3.5" /> New
          </Button>
        </div>

        {showNewAudience && (
          <div className="border border-border rounded-xl p-3 bg-card flex flex-col gap-2">
            <Input placeholder="Audience name" value={newAudienceName} onChange={e => setNewAudienceName(e.target.value)} className="h-8 text-sm" />
            <Input placeholder="Description (optional)" value={newAudienceDesc} onChange={e => setNewAudienceDesc(e.target.value)} className="h-8 text-sm" />
            <div className="flex gap-2">
              <Button size="sm" onClick={createAudience} className="flex-1 h-7 text-xs">Create</Button>
              <Button size="sm" variant="ghost" onClick={() => setShowNewAudience(false)} className="h-7 text-xs">Cancel</Button>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1 flex-1 min-h-0 overflow-y-auto">
          {audiences.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">No audiences yet</p>}
          {audiences.map(a => (
            <button
              key={a.id}
              onClick={() => selectAudience(a)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors group",
                selectedAudience?.id === a.id ? "bg-primary/10" : "hover:bg-muted/60"
              )}
            >
              <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: a.color }} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{a.name}</p>
                <div className="flex items-center gap-1.5">
                  <p className="text-xs text-muted-foreground">{a.contact_count} contacts</p>
                  {(contactedByAudience[a.id] || 0) > 0 && (
                    <span
                      title={`${contactedByAudience[a.id]} of ${a.contact_count} already emailed (in a flow or a Compose campaign)`}
                      className="flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap"
                    >
                      <span
                        className={cn(
                          "w-1.5 h-1.5 rounded-full",
                          (contactedByAudience[a.id] || 0) >= (a.contact_count || 0)
                            ? "bg-muted-foreground/40"
                            : "bg-amber-500"
                        )}
                      />
                      {contactedByAudience[a.id]} contacted
                    </span>
                  )}
                </div>
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
              <button onClick={e => { e.stopPropagation(); setAudienceToDelete(a); }} className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-destructive">
                <Trash2 className="w-3 h-3" />
              </button>
            </button>
          ))}
        </div>
      </div>

      {/* Right: Contacts panel — the contacts table scrolls on its own */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {!selectedAudience ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <Users className="w-10 h-10 mb-3 opacity-30" />
            <p className="text-sm">Select an audience to view contacts</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 h-full min-h-0">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium text-foreground flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full" style={{ background: selectedAudience.color }} />
                  {selectedAudience.name}
                </h3>
                <p className="text-xs text-muted-foreground">{contacts.length} contacts</p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="gap-1.5 text-xs h-8" onClick={verifyList} disabled={verifying || contacts.length === 0}
                  title="Free check: flags dead domains, disposable, role and typo addresses and blocks the bad ones from sending">
                  {verifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                  {verifying ? (verifyProgress ? `Verifying ${verifyProgress.done}/${verifyProgress.total}` : "Verifying…") : "Verify emails"}
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5 text-xs h-8" onClick={() => setShowManualAdd(!showManualAdd)}>
                  <Plus className="w-3.5 h-3.5" /> Add manually
                </Button>
                <label className="cursor-pointer">
                  <input type="file" accept=".json,.csv" className="hidden" onChange={handleFileUpload} />
                  <span className="inline-flex items-center gap-1.5 text-xs h-8 px-3 rounded-md border border-border bg-background hover:bg-muted/50 transition-colors font-medium cursor-pointer">
                    <Upload className="w-3.5 h-3.5" /> Upload file
                  </span>
                </label>
              </div>
            </div>

            {/* Verification report */}
            {verifyReport && (
              <div className="border border-border rounded-xl p-4 bg-muted/20 shrink-0">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-primary" /> Verified {verifyReport.total} addresses
                  </p>
                  <button onClick={() => setVerifyReport(null)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
                </div>
                <p className="text-xs text-muted-foreground mb-2.5">
                  <b className="text-foreground">{verifyReport.blocked}</b> bad address{verifyReport.blocked === 1 ? "" : "es"} added to the blacklist and will be skipped when sending. Role and typo addresses are flagged but not blocked (your call).
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {(Object.entries(verifyReport.summary) as [EmailVerdict, number][]).filter(([, n]) => n > 0).map(([v, n]) => (
                    <span key={v} className={cn("text-[11px] px-2 py-0.5 rounded-full border",
                      v === "valid" ? "border-emerald-300 text-emerald-700 bg-emerald-50" :
                      v === "role" || v === "typo" ? "border-amber-300 text-amber-700 bg-amber-50" :
                      "border-rose-300 text-rose-700 bg-rose-50")}>
                      {VERDICT_LABEL[v]}: {n}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Manual add form */}
            {showManualAdd && (
              <div className="border border-border rounded-xl p-4 bg-muted/30 grid grid-cols-2 gap-3">
                <Input placeholder="Name *" value={manualForm.name} onChange={e => setManualForm(f => ({ ...f, name: e.target.value }))} className="h-8 text-sm" />
                <Input placeholder="Email *" value={manualForm.email} onChange={e => setManualForm(f => ({ ...f, email: e.target.value }))} className="h-8 text-sm" />
                <Input placeholder="@username" value={manualForm.username} onChange={e => setManualForm(f => ({ ...f, username: e.target.value }))} className="h-8 text-sm" />
                <Input placeholder="Followers" type="number" value={manualForm.followers} onChange={e => setManualForm(f => ({ ...f, followers: e.target.value }))} className="h-8 text-sm" />
                <select value={manualForm.platform} onChange={e => setManualForm(f => ({ ...f, platform: e.target.value }))} className="h-8 text-sm border border-input rounded-md px-2 bg-background">
                  {Object.entries(PLATFORM_ICONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <Input placeholder="Bio snippet" value={manualForm.bio} onChange={e => setManualForm(f => ({ ...f, bio: e.target.value }))} className="h-8 text-sm" />
                <div className="col-span-2 flex gap-2">
                  <Button size="sm" onClick={addManualContact} className="h-7 text-xs">Add contact</Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowManualAdd(false)} className="h-7 text-xs">Cancel</Button>
                </div>
              </div>
            )}

            {/* Import preview */}
            {importPreview && (
              <div className="border border-border rounded-xl p-4 bg-muted/30">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-medium text-foreground">{importPreview.length} contacts ready to import</p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={confirmImport} disabled={importing || importPreview.length === 0} className="h-7 text-xs gap-1.5">
                      <Check className="w-3 h-3" /> Confirm import
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setImportPreview(null); setImportSkipped([]); }} className="h-7 text-xs"><X className="w-3 h-3" /></Button>
                  </div>
                </div>
                <div className="max-h-48 overflow-y-auto text-xs space-y-1">
                  {importPreview.slice(0, 10).map((c, i) => (
                    <div key={i} className="flex items-center gap-2 text-muted-foreground">
                      <span className="font-medium text-foreground">{c.name}</span>
                      <span>{c.email}</span>
                      {c.followers ? <span>{formatFollowers(c.followers)}</span> : null}
                    </div>
                  ))}
                  {importPreview.length > 10 && <p className="text-muted-foreground">+{importPreview.length - 10} more…</p>}
                </div>

                {/* Per-row skip report — exactly why each ignored row was dropped */}
                {importSkipped.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <p className="text-xs font-medium text-muted-foreground mb-1.5">{importSkipped.length} row{importSkipped.length === 1 ? "" : "s"} skipped — here is exactly why</p>
                    <div className="max-h-40 overflow-y-auto text-xs space-y-1">
                      {importSkipped.map((s, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <span className="font-mono text-muted-foreground shrink-0">Row {s.row}</span>
                          <span className="text-foreground/80 shrink-0">{s.reason}</span>
                          {s.preview && <span className="text-muted-foreground/60 truncate">— {s.preview}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Filters */}
            <div className="flex gap-2 flex-wrap shrink-0">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" className="h-7 pl-7 text-xs w-44" />
              </div>
              {STATUS_FILTERS.map(s => (
                <button key={s} onClick={() => setStatusFilter(s)}
                  className={cn("h-7 px-3 rounded-md text-xs font-medium transition-colors border", statusFilter === s ? "bg-muted text-foreground border-border" : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>

            {/* Contacts table — scrolls independently of the audience list on the left */}
            <div className="flex-1 min-h-0 overflow-y-auto">
            {loadingContacts ? (
              <div className="text-center py-8 text-muted-foreground text-sm">Loading…</div>
            ) : filteredContacts.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">No contacts match your filters</div>
            ) : (
              <div className="border border-border rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 border-b border-border">
                    <tr>
                      <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Name</th>
                      <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Email</th>
                      <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Platform</th>
                      <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Followers</th>
                      <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredContacts.map(c => (
                      <tr key={c.id} className="border-b border-border/50 last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-2">
                          <p className="font-medium text-foreground text-xs">{c.name}</p>
                          {c.username && <p className="text-xs text-muted-foreground">@{c.username}</p>}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{c.email}</td>
                        <td className="px-3 py-2">
                          {c.platform && (
                            <span className="text-xs text-muted-foreground">
                              {PLATFORM_ICONS[c.platform]?.label}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{formatFollowers(c.followers)}</td>
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span className={cn("w-1.5 h-1.5 rounded-full", STATUS_DOT[c.status] || "bg-muted-foreground/40")} />
                            {c.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            </div>
          </div>
        )}
      </div>

      {/* Delete audience — choose whether to also delete its contacts */}
      {audienceToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => { if (!deletingAudienceBusy) setAudienceToDelete(null); }}>
          <div className="bg-card border border-border rounded-2xl shadow-lg w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
            <h3 className="font-medium text-foreground text-base flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: audienceToDelete.color }} />
              Delete "{audienceToDelete.name}"?
            </h3>
            <p className="text-sm text-muted-foreground mt-1.5">
              This audience has {audienceToDelete.contact_count || 0} contact{(audienceToDelete.contact_count || 0) === 1 ? "" : "s"}. Choose what happens to them.
            </p>
            <div className="flex flex-col gap-2 mt-4">
              <button
                onClick={() => confirmDeleteAudience(false)}
                disabled={deletingAudienceBusy}
                className="text-left rounded-xl border border-border hover:bg-muted/40 px-3.5 py-3 transition-colors disabled:opacity-50"
              >
                <p className="text-sm font-medium text-foreground">Delete audience only</p>
                <p className="text-xs text-muted-foreground mt-0.5">Keep the contacts in your database, just unassign them from this audience.</p>
              </button>
              <button
                onClick={() => confirmDeleteAudience(true)}
                disabled={deletingAudienceBusy}
                className="text-left rounded-xl border border-destructive/40 hover:bg-destructive/5 px-3.5 py-3 transition-colors disabled:opacity-50"
              >
                <p className="text-sm font-medium text-destructive">Delete audience and its contacts</p>
                <p className="text-xs text-muted-foreground mt-0.5">Permanently remove this audience and all {audienceToDelete.contact_count || 0} contact{(audienceToDelete.contact_count || 0) === 1 ? "" : "s"} in it. This cannot be undone.</p>
              </button>
            </div>
            <div className="flex justify-end mt-4">
              <Button variant="ghost" size="sm" onClick={() => setAudienceToDelete(null)} disabled={deletingAudienceBusy}>
                {deletingAudienceBusy ? "Deleting…" : "Cancel"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
