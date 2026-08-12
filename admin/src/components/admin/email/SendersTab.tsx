import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, Eye, EyeOff, RefreshCw, CheckCircle2, AlertCircle, Server, Mail, ToggleLeft, ToggleRight, ExternalLink, Send, Settings, Layers, Clock, Check, X, Star, ShieldCheck, ShieldAlert } from "lucide-react";
import { setDefaultTarget } from "./outreach/senderTargets";
import DomainHealthDialog from "./outreach/DomainHealthDialog";
import { regionFromSmtpHost, domainOf } from "./outreach/dnsCheck";
import { fetchGuardSettings, saveGuardSettings, fetchSenderBounces, isOverThreshold, ratePct, DEFAULT_GUARD, type GuardSettings, type SenderBounce } from "./outreach/bounceGuard";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

interface SenderGroup {
  id: string;
  name: string;
  color: string;
  is_default?: boolean;
}

// Daily caps reset at UTC midnight; the worker counts a mailbox's sends since then, so
// the UI counts the same window and shows the countdown to the same moment.
function utcMidnight(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
function resetsIn(): string {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  const ms = next.getTime() - now.getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// One consistent usage read-out: how many of today's sends are used, what's left, and
// when it resets. Same component for a single sender and for each member of a group.
function UsageBar({ used, limit, paused }: { used: number; limit: number; paused?: boolean }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const left = Math.max(0, limit - used);
  const full = used >= limit;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className={cn("text-[11px] tabular-nums", paused ? "text-muted-foreground" : full ? "text-rose-600 font-medium" : "text-muted-foreground")}>
          {paused ? "Paused" : full ? "Daily limit reached" : `${left} left today`}
        </span>
        <span className="text-[11px] text-muted-foreground/70 tabular-nums">{used}/{limit}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", paused ? "bg-muted-foreground/40" : full ? "bg-rose-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500")}
          style={{ width: `${paused ? 100 : pct}%` }}
        />
      </div>
    </div>
  );
}

// One-click default. The same control sits on a mailbox row and a group row, because
// there is only ever one default between the two lists.
function DefaultStar({ active, disabled, title, onClick }: {
  active: boolean;
  disabled?: boolean;
  title: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled && !active}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded p-0.5 transition-colors",
        active ? "text-amber-500" : "text-muted-foreground/30 hover:text-amber-500",
        disabled && !active && "opacity-40 cursor-not-allowed hover:text-muted-foreground/30",
      )}
    >
      <Star className="w-3.5 h-3.5" fill={active ? "currentColor" : "none"} />
    </button>
  );
}

interface SenderAccount {
  id: string;
  name: string;
  from_name: string;
  from_email: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  is_default: boolean;
  created_at: string;
  imap_host?: string;
  imap_port?: number;
  imap_user?: string;
  imap_password?: string;
  imap_enabled?: boolean;
  is_active?: boolean;
  daily_limit?: number;
  signature?: string;
  group_id?: string | null;
  auto_paused_reason?: string | null;
  auto_paused_at?: string | null;
}

const EMPTY: Omit<SenderAccount, "id" | "created_at"> = {
  name: "",
  from_name: "",
  from_email: "",
  smtp_host: "",
  smtp_port: 587,
  smtp_user: "",
  smtp_password: "",
  is_default: false,
  imap_host: "",
  imap_port: 993,
  imap_user: "",
  imap_password: "",
  imap_enabled: false,
  is_active: true,
  daily_limit: 50,
  group_id: null,
};

export default function SendersTab() {
  const [senders, setSenders] = useState<SenderAccount[]>([]);
  const [groups, setGroups] = useState<SenderGroup[]>([]);
  // Sends per sender since UTC midnight — drives every usage bar.
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [view, setView] = useState<"senders" | "groups">("senders");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  // Clicking a sender shows INFO first; settings only open on demand.
  const [editing, setEditing] = useState(false);
  const [groupDraft, setGroupDraft] = useState<{ id: string | null; name: string; color: string } | null>(null);
  // Bulk daily-limit input for the open group. Seeded from the members' common value.
  const [bulkLimit, setBulkLimit] = useState<string>("");
  const [domainHealthOpen, setDomainHealthOpen] = useState(false);
  // Bounce circuit breaker: per-mailbox rates + the threshold settings.
  const [bounces, setBounces] = useState<Record<string, SenderBounce>>({});
  const [guard, setGuard] = useState<GuardSettings>(DEFAULT_GUARD);
  const [guardOpen, setGuardOpen] = useState(false);
  const [pausingOver, setPausingOver] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Omit<SenderAccount, "id" | "created_at">>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showSmtpPassword, setShowSmtpPassword] = useState(false);
  const [showImapPassword, setShowImapPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [testToEmail, setTestToEmail] = useState("");

  const fetchSenders = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("email_sender_accounts")
      .select("*")
      .order("created_at", { ascending: false });
    setSenders((data || []) as SenderAccount[]);
    setLoading(false);
  }, []);

  const fetchGroups = useCallback(async () => {
    const { data } = await supabase.from("sender_groups" as any).select("*").order("created_at");
    setGroups((data as unknown as SenderGroup[]) || []);
  }, []);

  // Count today's sends per mailbox (since UTC midnight) so the caps read live.
  const fetchUsage = useCallback(async () => {
    const { data } = await supabase
      .from("email_queue")
      .select("sender_account_id")
      .eq("status", "sent")
      .gte("sent_at", utcMidnight().toISOString())
      .not("sender_account_id", "is", null)
      .limit(10000);
    const map: Record<string, number> = {};
    for (const r of (data as { sender_account_id: string | null }[]) || []) {
      if (r.sender_account_id) map[r.sender_account_id] = (map[r.sender_account_id] || 0) + 1;
    }
    setUsage(map);
  }, []);

  useEffect(() => { fetchSenders(); fetchGroups(); fetchUsage(); }, [fetchSenders, fetchGroups, fetchUsage]);

  const fetchBounces = useCallback(async (ids: string[], lookback: number) => {
    if (ids.length === 0) { setBounces({}); return; }
    setBounces(await fetchSenderBounces(ids, lookback));
  }, []);

  useEffect(() => { fetchGuardSettings().then(setGuard); }, []);
  useEffect(() => {
    if (senders.length === 0) return;
    void fetchBounces(senders.map((x) => x.id), guard.lookback_days);
  }, [senders, guard.lookback_days, fetchBounces]);

  // Seed the bulk-limit box when a group opens: show the shared value if all members
  // agree, else blank so applying a number is a deliberate choice, not an accident.
  useEffect(() => {
    if (!selectedGroupId) return;
    const mems = senders.filter((s) => s.group_id === selectedGroupId);
    const limits = new Set(mems.map((m) => m.daily_limit ?? 50));
    setBulkLimit(limits.size === 1 ? String([...limits][0]) : "");
  }, [selectedGroupId, senders]);

  // One entry per sending domain, with the SES region parsed from its SMTP host.
  const domains = (() => {
    const m = new Map<string, string | null>();
    for (const s of senders) {
      const d = domainOf(s.from_email);
      if (!d) continue;
      if (!m.has(d) || (!m.get(d) && regionFromSmtpHost(s.smtp_host))) m.set(d, regionFromSmtpHost(s.smtp_host));
    }
    return [...m.entries()].map(([domain, region]) => ({ domain, region }));
  })();

  const overThreshold = senders.filter((x) => x.is_active !== false && isOverThreshold(bounces[x.id], guard));

  const usedOf = (s: SenderAccount) => usage[s.id] || 0;
  const limitOf = (s: SenderAccount) => s.daily_limit ?? 50;
  const groupMembers = (gid: string) => senders.filter((s) => s.group_id === gid);

  // Save a group (create or rename/recolor).
  const saveGroup = async () => {
    if (!groupDraft || !groupDraft.name.trim()) { toast.error("Group name is required"); return; }
    const payload = { name: groupDraft.name.trim(), color: groupDraft.color };
    if (groupDraft.id) {
      const { error } = await supabase.from("sender_groups" as any).update(payload).eq("id", groupDraft.id);
      if (error) { toast.error(error.message); return; }
      toast.success("Group updated");
    } else {
      const { data, error } = await supabase.from("sender_groups" as any).insert(payload).select("id").single();
      if (error) { toast.error(error.message); return; }
      toast.success("Group created");
      setSelectedGroupId((data as unknown as { id: string }).id);
    }
    setGroupDraft(null);
    await fetchGroups();
  };

  const deleteGroup = async (id: string) => {
    if (!confirm("Delete this group? Its senders stay, they just leave the group.")) return;
    await supabase.from("email_sender_accounts").update({ group_id: null } as any).eq("group_id", id);
    const { error } = await supabase.from("sender_groups" as any).delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    toast.success("Group deleted");
    setSelectedGroupId(null);
    await Promise.all([fetchGroups(), fetchSenders()]);
  };

  // Add/remove a sender from the open group.
  const setSenderGroup = async (senderId: string, gid: string | null) => {
    const { error } = await supabase.from("email_sender_accounts").update({ group_id: gid } as any).eq("id", senderId);
    if (error) { toast.error(error.message); return; }
    await fetchSenders();
  };

  // Set the SAME daily limit on every mailbox in a group in one shot, so you don't
  // open each sender to change its cap. Writes the per-sender daily_limit (the value
  // the worker and every usage bar already read), it just does the whole group at once.
  const setGroupDailyLimit = async (gid: string, perSender: number) => {
    const val = Math.max(1, Math.round(perSender));
    const { error } = await supabase.from("email_sender_accounts").update({ daily_limit: val } as any).eq("group_id", gid);
    if (error) { toast.error(error.message); return; }
    const n = groupMembers(gid).length;
    toast.success(`Set ${val}/day on ${n} mailbox${n === 1 ? "" : "es"}`);
    await Promise.all([fetchSenders(), fetchUsage()]);
  };

  // One default across BOTH lists: a mailbox or a group, never both. Available as a
  // one-click star on every row so you never have to open settings just to switch it.
  const makeDefault = async (kind: "sender" | "group", id: string, label: string) => {
    try {
      await setDefaultTarget(kind, id);
      toast.success(label + ' is now the default \u2014 flows and Compose set to "Default" use it');
      await Promise.all([fetchSenders(), fetchGroups()]);
    } catch (e: unknown) {
      toast.error("Couldn't set the default: " + (e as Error).message);
    }
  };

  // Manually apply the breaker now (the worker does this automatically at send time;
  // this is the "do it while I watch" button, useful before a live send).
  const pauseOverThreshold = async () => {
    if (overThreshold.length === 0) return;
    setPausingOver(true);
    try {
      const at = new Date().toISOString();
      for (const x of overThreshold) {
        await supabase.from("email_sender_accounts").update({
          is_active: false,
          auto_paused_reason: `Bounce rate ${ratePct(bounces[x.id])}% over ${bounces[x.id]?.sent ?? 0} sends (limit ${guard.threshold_pct}%)`,
          auto_paused_at: at,
        } as any).eq("id", x.id);
      }
      toast.success(`Paused ${overThreshold.length} mailbox${overThreshold.length === 1 ? "" : "es"} over the bounce limit`);
      await fetchSenders();
    } finally { setPausingOver(false); }
  };

  // Reactivate a mailbox that the guard paused, and clear the reason.
  const clearAutoPause = async (id: string) => {
    await supabase.from("email_sender_accounts").update({ is_active: true, auto_paused_reason: null, auto_paused_at: null } as any).eq("id", id);
    toast.success("Mailbox reactivated");
    await fetchSenders();
  };

  const persistGuard = async (next: GuardSettings) => {
    setGuard(next);
    try { await saveGuardSettings(next); } catch (e) { toast.error("Couldn't save: " + (e as Error).message); }
  };

  const selectSender = (s: SenderAccount) => {
    setSelectedGroupId(null);
    setEditing(false);
    setSelectedId(s.id);
    setCreating(false);
    setForm({
      name: s.name,
      from_name: s.from_name,
      from_email: s.from_email,
      smtp_host: s.smtp_host,
      smtp_port: s.smtp_port,
      smtp_user: s.smtp_user,
      smtp_password: s.smtp_password,
      is_default: s.is_default,
      imap_host: s.imap_host || "",
      imap_port: s.imap_port || 993,
      imap_user: s.imap_user || "",
      imap_password: s.imap_password || "",
      imap_enabled: s.imap_enabled || false,
      is_active: s.is_active ?? true,
      daily_limit: s.daily_limit ?? 50,
      group_id: s.group_id ?? null,
    });
    setTestResult(null);
  };

  const startCreate = () => {
    setSelectedId(null);
    setSelectedGroupId(null);
    setCreating(true);
    setEditing(true);
    setForm(EMPTY);
    setTestResult(null);
  };

  const handleSave = async () => {
    if (!form.name || !form.from_email || !form.smtp_host || !form.smtp_user) {
      toast.error("Fill in all required fields");
      return;
    }
    // Trim all credential fields to prevent invisible whitespace issues
    const trimmedForm = {
      ...form,
      name: form.name.trim(),
      from_name: form.from_name?.trim() ?? "",
      from_email: form.from_email.trim(),
      smtp_host: form.smtp_host.trim(),
      smtp_user: form.smtp_user.trim(),
      smtp_password: form.smtp_password?.trim() ?? "",
      imap_host: form.imap_host?.trim() ?? null,
      imap_user: form.imap_user?.trim() ?? null,
      imap_password: form.imap_password?.trim() ?? null,
    };
    setSaving(true);
    try {
      if (creating) {
        const { data, error } = await supabase
          .from("email_sender_accounts")
          .insert({ ...trimmedForm })
          .select()
          .single();
        if (error) throw error;
        if (trimmedForm.is_default) await setDefaultTarget("sender", data.id);
        toast.success("Sender account created");
        setCreating(false);
        setSelectedId(data.id);
      } else if (selectedId) {
        const { error } = await supabase
          .from("email_sender_accounts")
          .update({ ...trimmedForm })
          .eq("id", selectedId);
        if (error) throw error;
        if (trimmedForm.is_default) await setDefaultTarget("sender", selectedId);
        toast.success("Sender account updated");
      }
      await Promise.all([fetchSenders(), fetchGroups(), fetchUsage()]);
      setEditing(false);
    } catch (e: unknown) {
      toast.error("Failed to save: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    const s = senders.find((x) => x.id === selectedId);
    if (!confirm(
      `Delete ${s?.from_email || "this sender"}?\n\n` +
      "Its sent history stays. Campaigns and flows that used it fall back to the default sender.",
    )) return;
    setDeleting(true);
    try {
      // Unlink first. outreach_campaigns.sender_account_id was created without an
      // ON DELETE rule, so Postgres blocks the delete (409) for any mailbox that ever
      // sent a campaign — which is every real one, including via the hidden Flows
      // campaign. Nulling the reference keeps the campaign and its history and lets
      // the delete through. Migration 20260716120000 makes the FK do this itself; this
      // stays because it also covers references added outside migrations.
      await supabase.from("outreach_campaigns").update({ sender_account_id: null }).eq("sender_account_id", selectedId);
      await supabase.from("email_flows" as any).update({ sender_account_id: null }).eq("sender_account_id", selectedId);
      const { error } = await supabase.from("email_sender_accounts").delete().eq("id", selectedId);
      if (error) throw error;
      toast.success("Sender account deleted");
      setSelectedId(null);
      setCreating(false);
      setEditing(false);
      await Promise.all([fetchSenders(), fetchGroups()]);
    } catch (e: unknown) {
      // Surface the real reason. A bare "Failed to delete" on a 409 says nothing about
      // which table is still holding the row.
      const err = e as { message?: string; details?: string };
      toast.error(`Couldn't delete: ${err.message || "unknown error"}${err.details ? ` (${err.details})` : ""}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("test-smtp-sender", {
        body: {
          smtp_host: form.smtp_host,
          smtp_port: form.smtp_port,
          smtp_user: form.smtp_user,
          smtp_password: form.smtp_password,
          from_email: form.from_email,
          from_name: form.from_name,
          test_to: testToEmail.trim() || form.smtp_user,
        },
      });
      if (error) throw error;
      if (data?.ok) {
        setTestResult({ ok: true, message: data.message || "Test email sent! Check your inbox." });
      } else {
        setTestResult({ ok: false, message: data?.error || "Connection failed" });
      }
    } catch (e: unknown) {
      setTestResult({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const isEditing = creating || selectedId !== null;

  return (
    <div className="grid grid-cols-[280px_1fr] gap-6 min-h-[500px]">
      {/* Left sidebar */}
      <div className="space-y-3">
        {/* Senders vs Groups */}
        <div className="flex bg-muted/40 rounded-lg p-0.5">
          {(["senders", "groups"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn("flex-1 py-1.5 text-xs rounded-md capitalize transition-colors", view === v ? "bg-background shadow-sm text-foreground font-medium" : "text-muted-foreground hover:text-foreground")}
            >
              {v === "senders" ? `Senders ${senders.length}` : `Groups ${groups.length}`}
            </button>
          ))}
        </div>

        <Button
          onClick={() => (view === "senders" ? startCreate() : setGroupDraft({ id: null, name: "", color: "#6366f1" }))}
          className="w-full"
          size="sm"
        >
          <Plus className="w-4 h-4 mr-1" />
          {view === "senders" ? "New sender" : "New group"}
        </Button>

        {/* Deliverability tools: check the domains' DNS, and the bounce guard. */}
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={() => setDomainHealthOpen(true)} title="Check SPF, DMARC and MAIL FROM for every sending domain. Nothing is sent.">
            <ShieldCheck className="w-3.5 h-3.5" /> Check domains
          </Button>
          <Button variant="outline" size="sm" className={cn("gap-1.5", overThreshold.length > 0 && "border-red-300 text-red-600")}
            onClick={() => setGuardOpen(true)} title="Bounce circuit breaker settings">
            <ShieldAlert className="w-3.5 h-3.5" /> {guard.enabled ? `${guard.threshold_pct}%` : "off"}
          </Button>
        </div>

        {overThreshold.length > 0 && (
          <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/20 p-2.5 space-y-1.5">
            <p className="text-xs text-red-700 font-medium flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              {overThreshold.length} mailbox{overThreshold.length === 1 ? "" : "es"} over the {guard.threshold_pct}% bounce limit
            </p>
            <p className="text-[11px] text-red-700/80">SES suspends the whole account above ~5%. Pause these before your next send.</p>
            <Button size="sm" variant="destructive" className="h-7 w-full" disabled={pausingOver} onClick={pauseOverThreshold}>
              Pause {overThreshold.length === 1 ? "it" : "them"} now
            </Button>
          </div>
        )}

        {view === "groups" ? (
          groups.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">No groups yet. A group rotates its senders one lead at a time.</div>
          ) : (
            <div className="space-y-2">
              {groups.map((g) => {
                const members = groupMembers(g.id);
                const used = members.reduce((n, m) => n + usedOf(m), 0);
                const cap = members.reduce((n, m) => n + (m.is_active === false ? 0 : limitOf(m)), 0);
                const activeMembers = members.filter((m) => m.is_active !== false).length;
                return (
                  <div
                    key={g.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => { setSelectedGroupId(g.id); setSelectedId(null); setCreating(false); setEditing(false); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedGroupId(g.id); setSelectedId(null); setCreating(false); setEditing(false); } }}
                    className={cn("w-full text-left p-3 rounded-lg border transition-colors hover:bg-muted/50 cursor-pointer", selectedGroupId === g.id ? "border-primary bg-primary/5" : "border-border")}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: g.color }} />
                      <p className="font-medium text-sm truncate flex-1">{g.name}</p>
                      {g.is_default && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium shrink-0">Default</span>}
                      <span className="text-[10px] text-muted-foreground shrink-0">{members.length}</span>
                      <DefaultStar
                        active={!!g.is_default}
                        disabled={activeMembers === 0}
                        title={activeMembers === 0
                          ? "Add an active mailbox to this group before making it the default"
                          : g.is_default ? "This group is the default" : "Make " + g.name + " the default"}
                        onClick={(e) => { e.stopPropagation(); if (!g.is_default) void makeDefault("group", g.id, g.name); }}
                      />
                    </div>
                    <UsageBar used={used} limit={cap || 1} />
                  </div>
                );
              })}
            </div>
          )
        ) : loading ? (
          <div className="text-center py-8 text-muted-foreground text-sm">Loading…</div>
        ) : senders.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm">No sender accounts yet</div>
        ) : (
          <div className="space-y-2">
            {senders.map((s) => (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onClick={() => selectSender(s)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectSender(s); } }}
                className={`w-full text-left p-3 rounded-lg border transition-colors hover:bg-muted/50 cursor-pointer ${selectedId === s.id && !creating ? "border-primary bg-primary/5" : "border-border"} ${s.is_active === false ? "opacity-60" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{s.from_email}</p>
                    <p className="text-xs text-muted-foreground/70 truncate">{s.from_name || s.name}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {s.is_active === false && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400 font-medium">Paused</span>
                    )}
                    {s.imap_enabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 font-medium">IMAP</span>
                    )}
                    {s.is_default && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">Default</span>
                    )}
                    <DefaultStar
                      active={!!s.is_default}
                      disabled={s.is_active === false}
                      title={s.is_active === false
                        ? "Un-pause this mailbox before making it the default"
                        : s.is_default ? "This mailbox is the default" : "Make " + s.from_email + " the default"}
                      onClick={(e) => { e.stopPropagation(); if (!s.is_default) void makeDefault("sender", s.id, s.from_email); }}
                    />
                  </div>
                </div>
                <div className="mt-2">
                  <UsageBar used={usedOf(s)} limit={limitOf(s)} paused={s.is_active === false} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right panel */}
      <div className="border rounded-xl p-6 bg-card overflow-y-auto max-h-[calc(100vh-300px)]">
        {groupDraft ? (
          /* Create / rename a group */
          <div className="space-y-4 max-w-md">
            <h2 className="font-semibold text-base">{groupDraft.id ? "Rename group" : "New sender group"}</h2>
            <p className="text-sm text-muted-foreground -mt-2">A group rotates its senders, one lead at a time.</p>
            <div className="space-y-1.5">
              <Label>Group name</Label>
              <Input value={groupDraft.name} onChange={(e) => setGroupDraft((d) => (d ? { ...d, name: e.target.value } : d))} placeholder="e.g. Cold outreach v1" />
            </div>
            <div className="space-y-1.5">
              <Label>Colour</Label>
              <div className="flex gap-1.5">
                {["#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ef4444", "#14b8a6"].map((c) => (
                  <button key={c} onClick={() => setGroupDraft((d) => (d ? { ...d, color: c } : d))}
                    className={cn("w-6 h-6 rounded-full", groupDraft.color === c && "ring-2 ring-offset-2 ring-foreground/40")} style={{ background: c }} />
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={saveGroup}><Check className="w-3.5 h-3.5 mr-1" />{groupDraft.id ? "Save" : "Create group"}</Button>
              <Button size="sm" variant="ghost" onClick={() => setGroupDraft(null)}>Cancel</Button>
            </div>
          </div>
        ) : selectedGroupId ? (
          /* Group overview: each member's own limit, same read-out as a single sender */
          (() => {
            const g = groups.find((x) => x.id === selectedGroupId);
            if (!g) return null;
            const members = groupMembers(g.id);
            const others = senders.filter((s) => s.group_id !== g.id);
            const gUsed = members.reduce((n, m) => n + usedOf(m), 0);
            const gCap = members.reduce((n, m) => n + (m.is_active === false ? 0 : limitOf(m)), 0);
            return (
              <div className="space-y-5 max-w-xl">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-semibold text-base truncate flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: g.color }} />{g.name}
                    </h2>
                    <p className="text-sm text-muted-foreground mt-0.5">{members.length} sender{members.length === 1 ? "" : "s"} · rotates one lead at a time</p>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    {g.is_default ? (
                      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border border-primary/30 text-primary bg-primary/5">
                        <Star className="w-3 h-3" fill="currentColor" /> Default
                      </span>
                    ) : (
                      <Button size="sm" variant="outline" className="gap-1.5"
                        disabled={members.filter((m) => m.is_active !== false).length === 0}
                        title={members.filter((m) => m.is_active !== false).length === 0 ? "Add an active mailbox first" : "Everything set to \"Default\" will rotate across this group"}
                        onClick={() => makeDefault("group", g.id, g.name)}>
                        <Star className="w-3.5 h-3.5" /> Set as default
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setGroupDraft({ id: g.id, name: g.name, color: g.color })}>Rename</Button>
                    <Button size="sm" variant="outline" className="text-destructive" onClick={() => deleteGroup(g.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
                  </div>
                </div>

                <div className="rounded-xl border p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">Today across the group</p>
                    <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Clock className="w-3 h-3" /> resets in {resetsIn()}</span>
                  </div>
                  <UsageBar used={gUsed} limit={gCap || 1} />
                  <p className="text-xs text-muted-foreground">{Math.max(0, gCap - gUsed)} of {gCap} sends left today across active senders.</p>

                  {members.length > 0 && (() => {
                    const limits = new Set(members.map((m) => m.daily_limit ?? 50));
                    const mixed = limits.size > 1;
                    const applied = bulkLimit !== "" && Number(bulkLimit) > 0;
                    const unchanged = !mixed && applied && Number(bulkLimit) === [...limits][0];
                    return (
                      <div className="pt-2 mt-1 border-t border-border/60 flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">Daily limit for every mailbox</span>
                        <Input
                          type="number" min={1} value={bulkLimit}
                          onChange={(e) => setBulkLimit(e.target.value)}
                          placeholder={mixed ? "mixed" : ""}
                          className="h-8 w-24 text-sm"
                        />
                        <span className="text-xs text-muted-foreground">/day each</span>
                        <Button
                          size="sm" className="h-8"
                          disabled={!applied || unchanged}
                          onClick={() => setGroupDailyLimit(g.id, Number(bulkLimit))}
                        >
                          Apply to all {members.length}
                        </Button>
                        {mixed && !applied && (
                          <span className="text-[11px] text-amber-600 w-full">Members have different limits. Enter one to set them all the same.</span>
                        )}
                      </div>
                    );
                  })()}
                </div>

                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Senders in this group</p>
                  {members.length === 0 && <p className="text-xs text-muted-foreground">No senders yet — add one below.</p>}
                  {members.map((m) => (
                    <div key={m.id} className="flex items-center gap-3 rounded-lg border p-3">
                      <div className="min-w-0 w-[42%]">
                        <p className="text-sm truncate">{m.from_email}</p>
                        <p className="text-[11px] text-muted-foreground/60 truncate">{m.from_name || m.name}</p>
                      </div>
                      <UsageBar used={usedOf(m)} limit={limitOf(m)} paused={m.is_active === false} />
                      <button onClick={() => setSenderGroup(m.id, null)} title="Remove from group" className="shrink-0 text-muted-foreground hover:text-destructive"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>

                {others.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Add a sender</p>
                    <select defaultValue="" onChange={(e) => { if (e.target.value) { void setSenderGroup(e.target.value, g.id); e.target.value = ""; } }}
                      className="w-full h-9 text-sm border border-input rounded-md px-2 bg-background">
                      <option value="">Pick a sender…</option>
                      {others.map((s) => <option key={s.id} value={s.id}>{s.from_email}{s.group_id ? " (moves from another group)" : ""}</option>)}
                    </select>
                  </div>
                )}
              </div>
            );
          })()
        ) : !(creating || editing) ? (
          selectedId ? (
            /* Sender overview — info first, settings only when asked for */
            (() => {
              const s = senders.find((x) => x.id === selectedId);
              if (!s) return null;
              const used = usedOf(s), limit = limitOf(s), paused = s.is_active === false;
              const g = groups.find((x) => x.id === s.group_id);
              return (
                <div className="space-y-5 max-w-xl">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-semibold text-base truncate">{s.from_email}</h2>
                      <p className="text-sm text-muted-foreground/70 mt-0.5">{s.from_name || s.name}</p>
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      {!s.is_default && (
                        <Button size="sm" variant="outline" className="gap-1.5"
                          disabled={paused}
                          title={paused ? "Un-pause this mailbox first" : "Everything set to \"Default\" will send from this mailbox"}
                          onClick={() => makeDefault("sender", s.id, s.from_email)}>
                          <Star className="w-3.5 h-3.5" /> Set as default
                        </Button>
                      )}
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditing(true)}>
                        <Settings className="w-3.5 h-3.5" /> Settings
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <span className={cn("text-[11px] px-2 py-0.5 rounded-full border", paused ? "border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/30" : "border-emerald-300 text-emerald-700 bg-emerald-50 dark:bg-emerald-950/30")}>
                      {paused ? "Paused" : "Active"}
                    </span>
                    <span className={cn("text-[11px] px-2 py-0.5 rounded-full border", s.imap_enabled ? "border-blue-300 text-blue-700 bg-blue-50 dark:bg-blue-950/30" : "border-border text-muted-foreground")}>
                      {s.imap_enabled ? "Replies synced" : "No reply sync"}
                    </span>
                    {s.is_default && <span className="text-[11px] px-2 py-0.5 rounded-full border border-primary/30 text-primary bg-primary/5">Default</span>}
                    {g && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full border border-border text-muted-foreground inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: g.color }} />{g.name}
                      </span>
                    )}
                  </div>

                  <div className="rounded-xl border p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Today's sending</p>
                      <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Clock className="w-3 h-3" /> resets in {resetsIn()}</span>
                    </div>
                    <UsageBar used={used} limit={limit} paused={paused} />
                    <p className="text-xs text-muted-foreground">
                      {paused
                        ? "Paused — rotation skips this mailbox and it won't send."
                        : used >= limit
                          ? "Daily limit reached. Sending resumes after the reset."
                          : `${limit - used} of ${limit} still available today.`}
                    </p>
                  </div>

                  {/* Auto-pause banner: this mailbox was paused by the bounce guard. */}
                  {s.auto_paused_reason && (
                    <div className="rounded-xl border border-red-300 bg-red-50 dark:bg-red-950/20 p-3 space-y-1.5">
                      <p className="text-xs text-red-700 font-medium flex items-center gap-1.5"><ShieldAlert className="w-3.5 h-3.5 shrink-0" /> Auto-paused by the bounce guard</p>
                      <p className="text-[11px] text-red-700/80">{s.auto_paused_reason}</p>
                      <Button size="sm" variant="outline" className="h-7" onClick={() => clearAutoPause(s.id)}>Reactivate</Button>
                    </div>
                  )}

                  {/* Bounce rate over the guard's window. */}
                  {(() => {
                    const b = bounces[s.id];
                    const sent = b?.sent ?? 0;
                    const pct = ratePct(b);
                    const over = isOverThreshold(b, guard);
                    return (
                      <div className="rounded-xl border p-4 space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium">Bounce rate</p>
                          <span className="text-[11px] text-muted-foreground">last {guard.lookback_days} days</span>
                        </div>
                        {sent === 0 ? (
                          <p className="text-xs text-muted-foreground">No sends yet in this window.</p>
                        ) : (
                          <p className="text-xs">
                            <span className={cn("font-semibold", over ? "text-red-600" : pct >= guard.threshold_pct / 2 ? "text-amber-600" : "text-emerald-600")}>{pct}%</span>
                            <span className="text-muted-foreground"> — {b?.bounced ?? 0} of {sent} sends bounced.</span>
                            {over && <span className="text-red-600 font-medium"> Over the {guard.threshold_pct}% limit.</span>}
                            {!over && sent < guard.min_sample && <span className="text-muted-foreground/70"> Below the {guard.min_sample}-send minimum, so the guard won't act yet.</span>}
                          </p>
                        )}
                      </div>
                    );
                  })()}

                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="rounded-lg border p-3 min-w-0">
                      <p className="text-muted-foreground mb-0.5">Sends via SMTP</p>
                      <p className="text-foreground truncate">{s.smtp_host}:{s.smtp_port}</p>
                    </div>
                    <div className="rounded-lg border p-3 min-w-0">
                      <p className="text-muted-foreground mb-0.5">Receives via IMAP</p>
                      <p className={cn("truncate", s.imap_enabled ? "text-foreground" : "text-amber-600")}>
                        {s.imap_enabled ? `${s.imap_host}:${s.imap_port || 993}` : "Not set — replies won't be captured"}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <Server className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm">{view === "groups" ? "Select a group or create one" : "Select a sender or create a new one"}</p>
            </div>
          )
        ) : (
          <div className="space-y-5 max-w-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-base">{creating ? "New sender account" : "Sender settings"}</h2>
                <p className="text-sm text-muted-foreground mt-0.5">Configure SMTP (outbound) and optionally IMAP (inbound reply sync).</p>
              </div>
              {!creating && (
                <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setEditing(false)}>Back</Button>
              )}
            </div>

            {/* Brevo domain verification banner */}
            {form.smtp_host.includes("brevo.com") && (
              <div className="flex items-start gap-2.5 p-3 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 text-sm">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <div className="space-y-1">
                  <p className="font-medium">Domain verification required in Brevo</p>
                  <p className="text-xs opacity-80">Brevo silently discards emails from unverified domains even though SMTP returns 250 OK. Add <strong>renov.space</strong> and its DNS records in your Brevo account to start delivering.</p>
                  <a
                    href="https://app.brevo.com/senders/domain/list"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium underline hover:no-underline"
                  >
                    Open Brevo domain settings <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            )}

            {/* Display name */}
            <div className="space-y-1.5">
              <Label>Display name <span className="text-destructive">*</span></Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Renov Marketing"
              />
              <p className="text-xs text-muted-foreground">Internal label — not shown to recipients</p>
            </div>

            {/* From name + email */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>From name <span className="text-destructive">*</span></Label>
                <Input
                  value={form.from_name}
                  onChange={(e) => setForm((f) => ({ ...f, from_name: e.target.value }))}
                  placeholder="Renov"
                />
              </div>
              <div className="space-y-1.5">
                <Label>From email <span className="text-destructive">*</span></Label>
                <Input
                  type="email"
                  value={form.from_email}
                  onChange={(e) => setForm((f) => ({ ...f, from_email: e.target.value }))}
                  placeholder="hello@renov.space"
                />
              </div>
            </div>

            {/* Sending controls: active toggle, daily cap, signature */}
            <div className="space-y-3 pt-2 border-t">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Send className="w-4 h-4 text-muted-foreground" />
                  <p className="text-sm font-medium">Sending controls</p>
                </div>
                <button type="button" onClick={() => setForm((f) => ({ ...f, is_active: !(f.is_active ?? true) }))} className="inline-flex items-center gap-1.5 text-sm font-medium">
                  {(form.is_active ?? true) ? <ToggleRight className="w-6 h-6 text-emerald-500" /> : <ToggleLeft className="w-6 h-6 text-muted-foreground" />}
                  {(form.is_active ?? true) ? "Active" : "Paused"}
                </button>
              </div>
              <p className="text-xs text-muted-foreground -mt-1">Paused senders are skipped by rotation and won't send — use it to pull a flagged mailbox without deleting it.</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Daily send limit</Label>
                  <Input type="number" min={1} value={form.daily_limit ?? 50}
                    onChange={(e) => setForm((f) => ({ ...f, daily_limit: Math.max(1, parseInt(e.target.value) || 1) }))} />
                  <p className="text-xs text-muted-foreground">Max sends/day from this mailbox. When hit, sending holds until tomorrow.</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                This sender's <b className="text-foreground">From name</b> above fills <code className="bg-muted px-1 rounded">{"{{sender_name}}"}</code> and{" "}
                <code className="bg-muted px-1 rounded">{"{{sender_first_name}}"}</code> in any email it sends, so write the sign-off once in the
                template and every persona signs with their own name.
              </p>
            </div>

            {/* SMTP */}
            <div className="space-y-3 pt-2 border-t">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-muted-foreground" />
                <p className="text-sm font-medium">SMTP — Outbound sending</p>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2 space-y-1.5">
                  <Label>Host <span className="text-destructive">*</span></Label>
                  <Input
                    value={form.smtp_host}
                    onChange={(e) => setForm((f) => ({ ...f, smtp_host: e.target.value }))}
                    placeholder="smtp.ionos.com"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Port</Label>
                  <Input
                    type="number"
                    value={form.smtp_port}
                    onChange={(e) => setForm((f) => ({ ...f, smtp_port: parseInt(e.target.value) || 587 }))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Username <span className="text-destructive">*</span></Label>
                  <Input
                    value={form.smtp_user}
                    onChange={(e) => setForm((f) => ({ ...f, smtp_user: e.target.value }))}
                    placeholder="user@renov.space"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Password <span className="text-[10px] font-normal text-muted-foreground">(optional)</span></Label>
                  <div className="relative">
                    <Input
                      type={showSmtpPassword ? "text" : "password"}
                      value={form.smtp_password}
                      onChange={(e) => setForm((f) => ({ ...f, smtp_password: e.target.value }))}
                      placeholder="Leave blank to use default SMTP secret"
                      autoComplete="new-password"
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSmtpPassword((p) => !p)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showSmtpPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">If empty, sends use the project's default SMTP password. Set this to override per Brevo account.</p>
                </div>
              </div>
            </div>

            {/* IMAP section */}
            <div className="space-y-3 pt-2 border-t">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                  <p className="text-sm font-medium">IMAP — Inbound reply sync</p>
                </div>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, imap_enabled: !f.imap_enabled }))}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {form.imap_enabled
                    ? <ToggleRight className="w-5 h-5 text-primary" />
                    : <ToggleLeft className="w-5 h-5" />}
                  {form.imap_enabled ? "Enabled" : "Disabled"}
                </button>
              </div>
              <div className="rounded-lg border border-blue-200 dark:border-blue-800/50 bg-blue-50 dark:bg-blue-950/30 p-3 text-xs text-blue-800 dark:text-blue-300 space-y-1">
                <p className="font-medium">⚠️ Brevo is outbound (SMTP) only — it does not support IMAP</p>
                <p className="opacity-80">To sync replies, configure IMAP with the actual inbox that receives them. For IONOS (getrenov.online): host <strong>imap.ionos.co.uk</strong>, port <strong>993</strong>, user is the full address, password is the mailbox password. For Google Workspace / Gmail: host <strong>imap.gmail.com</strong>, port <strong>993</strong>. For Outlook / Microsoft 365: host <strong>outlook.office365.com</strong>, port <strong>993</strong>.</p>
              </div>
              <p className="text-xs text-muted-foreground">
                When enabled, the system polls this mailbox every 5 minutes to auto-detect replies from outreach contacts.
              </p>

              {form.imap_enabled && (
                <div className="space-y-3 pl-3 border-l-2 border-primary/20">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="col-span-2 space-y-1.5">
                      <Label>IMAP Host</Label>
                      <Input
                        value={form.imap_host}
                        onChange={(e) => setForm((f) => ({ ...f, imap_host: e.target.value }))}
                        placeholder="imap.ionos.com"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Port</Label>
                      <Input
                        type="number"
                        value={form.imap_port}
                        onChange={(e) => setForm((f) => ({ ...f, imap_port: parseInt(e.target.value) || 993 }))}
                        placeholder="993"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>Username</Label>
                      <Input
                        value={form.imap_user}
                        onChange={(e) => setForm((f) => ({ ...f, imap_user: e.target.value }))}
                        placeholder="user@renov.space"
                        autoComplete="off"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Password</Label>
                      <div className="relative">
                        <Input
                          type={showImapPassword ? "text" : "password"}
                          value={form.imap_password}
                          onChange={(e) => setForm((f) => ({ ...f, imap_password: e.target.value }))}
                          placeholder="IMAP password"
                          autoComplete="new-password"
                          className="pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowImapPassword((p) => !p)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          {showImapPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">Port 993 uses TLS (recommended). Port 143 uses STARTTLS.</p>
                </div>
              )}
            </div>

            {/* Default toggle */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="is_default"
                checked={form.is_default}
                onChange={(e) => setForm((f) => ({ ...f, is_default: e.target.checked }))}
                className="w-4 h-4 rounded"
              />
              <Label htmlFor="is_default" className="cursor-pointer">Set as default sender <span className="text-muted-foreground font-normal">— takes the default away from any group that has it</span></Label>
              <span className="text-xs text-muted-foreground">(used when no sender is selected on a campaign)</span>
            </div>

            {/* Test result */}
            {testResult && (
              <div className={`flex items-start gap-2 p-3 rounded-lg text-sm ${testResult.ok ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800/50" : "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800/50"}`}>
                {testResult.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
                <span>{testResult.message}</span>
              </div>
            )}

            {/* Actions */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2">
                <Input
                  type="email"
                  value={testToEmail}
                  onChange={(e) => setTestToEmail(e.target.value)}
                  placeholder={`Send test to… (default: ${form.smtp_user || "smtp user"})`}
                  className="flex-1 h-8 text-sm"
                />
                <Button onClick={handleTest} disabled={testing || !form.smtp_host} variant="outline" size="sm">
                  {testing ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : <Send className="w-4 h-4 mr-1" />}
                  Send test email
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={handleSave} disabled={saving} size="sm">
                  {saving && <RefreshCw className="w-4 h-4 animate-spin mr-1" />}
                  Save
                </Button>
                {!creating && selectedId && (
                  <Button onClick={handleDelete} disabled={deleting} variant="outline" size="sm" className="text-destructive hover:bg-destructive/10 ml-auto">
                    <Trash2 className="w-4 h-4 mr-1" />
                    Delete
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <DomainHealthDialog open={domainHealthOpen} onOpenChange={setDomainHealthOpen} domains={domains} />
      <GuardSettingsDialog open={guardOpen} onOpenChange={setGuardOpen} settings={guard} onSave={persistGuard} overCount={overThreshold.length} />
    </div>
  );
}

// Bounce circuit breaker settings. The worker reads these at send time to auto-pause a
// mailbox whose bounce rate crosses the line, before it drags the whole SES account down.
function GuardSettingsDialog({ open, onOpenChange, settings, onSave, overCount }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  settings: GuardSettings;
  onSave: (s: GuardSettings) => void;
  overCount: number;
}) {
  const [draft, setDraft] = useState<GuardSettings>(settings);
  useEffect(() => { if (open) setDraft(settings); }, [open, settings]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldAlert className="w-5 h-5" /> Bounce circuit breaker</DialogTitle>
          <DialogDescription>
            Amazon SES suspends the whole account, not one domain, above ~5% bounces. This pauses a mailbox automatically once its recent bounce rate crosses your limit, so one bad list can't take everything down.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))} className="rounded" />
            <span className="text-sm font-medium">Auto-pause mailboxes over the limit</span>
          </label>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Bounce limit</Label>
              <div className="flex items-center gap-1">
                <Input type="number" min={1} max={100} value={draft.threshold_pct} onChange={(e) => setDraft((d) => ({ ...d, threshold_pct: Math.max(1, Number(e.target.value) || 1) }))} className="h-8" />
                <span className="text-xs text-muted-foreground">%</span>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Min sends</Label>
              <Input type="number" min={1} value={draft.min_sample} onChange={(e) => setDraft((d) => ({ ...d, min_sample: Math.max(1, Number(e.target.value) || 1) }))} className="h-8" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Window (days)</Label>
              <Input type="number" min={1} value={draft.lookback_days} onChange={(e) => setDraft((d) => ({ ...d, lookback_days: Math.max(1, Number(e.target.value) || 1) }))} className="h-8" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            A mailbox pauses when at least <b>{draft.min_sample}</b> emails have gone out in the last <b>{draft.lookback_days}</b> days and <b>{draft.threshold_pct}%</b> or more bounced. The minimum stops one bounce out of three from tripping it early.
          </p>
          {overCount > 0 && <p className="text-xs text-red-600">{overCount} mailbox{overCount === 1 ? " is" : "es are"} over this limit right now.</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button size="sm" onClick={() => { onSave(draft); onOpenChange(false); }}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
