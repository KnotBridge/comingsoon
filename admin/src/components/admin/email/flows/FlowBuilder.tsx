import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap,
  addEdge, useNodesState, useEdgesState, Handle, Position, useReactFlow,
  type Node, type Edge, type Connection, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { supabase } from "@/integrations/supabase/client";
import { EVENT_SELECT, countsAsOpen, countsAsClick, countsAsLoad, countsAsReply, countsAsBounce, emptyBucket, type NodeStats, type EmailBucketStats } from "./metrics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { buildEmailPreviewSrcDoc } from "@/components/admin/email/outreach/emailPreview";
import { TARGET_DEFAULT, parseTarget, targetValue } from "@/components/admin/email/outreach/senderTargets";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Zap, Mail, Clock, GitBranch, Target, Plus, Save, Trash2, Loader2, Play, Pause, Sparkles, Eye, RefreshCw, X, BarChart3, Settings, Send, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
// Raw sonner, NOT @/lib/toast: this is an admin tool, so we must see real success
// and error messages. The wrapper silences successes and rewrites every error to a
// generic "Oops…", which made a working enroll look like a failure.
import { toast } from "sonner";
import { AGENT_JOURNEY_TEMPLATES, INTRO_FALLBACK, SIG_MARK, FALLBACK_SIG, buildAgentJourney } from "./agentJourney";

// Pull the signature block off the PropStream intro (everything after the CTA,
// before the P.S.) so every follow-up can end with the exact same sign-off.
// Strips em dashes defensively. Returns "" if it can't find it (caller falls
// back to the text signature).
function extractSignature(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const container = doc.querySelector("body > div") || doc.body;
    const kids = Array.from(container.children);
    let psIdx = kids.findIndex((el) => /P\.S\./i.test(el.textContent || ""));
    if (psIdx < 0) psIdx = kids.length;
    const ctaIdx = kids.findIndex((el) => /claim here your free staging/i.test(el.textContent || ""));
    const start = ctaIdx >= 0 ? ctaIdx + 1 : kids.findIndex((el, i) => i < psIdx && /^\s*Justin\b/i.test((el.textContent || "").trim()));
    if (start < 0 || start >= psIdx) return "";
    const sig = kids.slice(start, psIdx).map((e) => e.outerHTML).join("\n");
    return sig.replace(/\s*—\s*/g, " ").trim();
  } catch {
    return "";
  }
}

// Outreach flows use the `outreach_templates` table (body_html); user flows use
// `email_templates` (html_template). This picks the right source per domain.
const TPL = {
  outreach: { table: "outreach_templates", htmlCol: "body_html" },
  user: { table: "email_templates", htmlCol: "html_template" },
} as const;

// Sample values for previewing merge tags as they'd render for a real business.
const DEMO_VARS: Record<string, string> = {
  business_name: "Glow Med Spa", name: "Glow Med Spa", first_name: "Glow",
  category: "Medical spa", city: "Austin", state: "TX",
  website: "glowmedspa.com", phone: "(512) 555-0142",
  rating: "4.8", review_count: "212", email: "hello@glowmedspa.com",
};
function fillDemo(s: string): string {
  return (s || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, k) => DEMO_VARS[k.toLowerCase()] ?? `{{${k}}}`);
}

// Heatmap color for a rate %. Open and click have different "good" thresholds.
const heat = (pct: number, hi: number, mid: number) =>
  pct >= hi ? "text-emerald-600" : pct >= mid ? "text-amber-600" : "text-orange-500";

// An A/B variant is sendable if it has a template (template mode) or a body (custom).
const resolvableVariant = (v?: { source?: string; templateId?: string; bodyHtml?: string }) =>
  v ? (v.source === "custom" ? !!v.bodyHtml : !!v.templateId) : false;
const abRate = (part: number, sent: number) => (sent > 0 ? Math.round((part / sent) * 100) : 0);
// Bounce is a BAD metric (high = bad), so its colours are inverted from heat().
// >=5% is SES's danger zone (red), >=2% a warning (amber), otherwise muted.
const bounceHeat = (pct: number) => (pct >= 5 ? "text-red-600 font-bold" : pct >= 2 ? "text-amber-600" : "text-muted-foreground");

// Seconds -> a short human phrase for the send-pacing control.
function humanInterval(s: number): string {
  if (s < 60) return `${s} sec`;
  if (s % 3600 === 0) return `${s / 3600} hr`;
  if (s % 60 === 0) return `${s / 60} min`;
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}m ${r}s`;
}
// Presets offered in the settings dropdown. "Default" is null (no throttle). The rest
// are common warm-up drips; a custom value is still allowed via the number input.
const INTERVAL_PRESETS: { label: string; value: number | null }[] = [
  { label: "Default — send as they're ready", value: null },
  { label: "One every 30 seconds", value: 30 },
  { label: "One every minute", value: 60 },
  { label: "One every 2 minutes", value: 120 },
  { label: "One every 5 minutes", value: 300 },
];

type Kind = "trigger" | "email" | "wait" | "condition" | "action";
type Domain = "user" | "outreach";

interface NodeData {
  kind: Kind;
  label: string;
  config: Record<string, any>;
  [key: string]: unknown;
}

const KINDS: Record<Kind, { label: string; icon: React.FC<{ className?: string }>; color: string }> = {
  trigger:   { label: "Trigger",   icon: Zap,       color: "border-amber-400/70 bg-amber-50" },
  email:     { label: "Send email", icon: Mail,     color: "border-blue-400/70 bg-blue-50" },
  wait:      { label: "Wait",      icon: Clock,      color: "border-purple-400/70 bg-purple-50" },
  condition: { label: "Condition", icon: GitBranch,  color: "border-orange-400/70 bg-orange-50" },
  action:    { label: "Goal / End", icon: Target,    color: "border-emerald-400/70 bg-emerald-50" },
};

// Trigger menus differ by domain.
const TRIGGERS: Record<Domain, { value: string; label: string }[]> = {
  user: [
    { value: "signed_up", label: "Signed up" },
    { value: "uploaded_room_left", label: "Uploaded a room, then left" },
    { value: "first_generation", label: "First generation made" },
    { value: "inactive_7d", label: "Inactive for 7 days" },
    { value: "inactive_30d", label: "Inactive for 30 days" },
    { value: "credits_low", label: "Credits running low" },
    { value: "abandoned_checkout", label: "Abandoned checkout" },
    { value: "trial_ending", label: "Trial ending soon" },
  ],
  outreach: [
    { value: "manual_enroll", label: "Manually enrolled (pick an audience)" },
    { value: "page_viewed", label: "Opened their listing page" },
  ],
};

const CONDITIONS: Record<Domain, { value: string; label: string }[]> = {
  user: [
    { value: "opened", label: "Opened the last email?" },
    { value: "clicked", label: "Clicked a link?" },
    { value: "active_since", label: "Active since enrolling?" },
    { value: "staged", label: "Staged a photo?" },
    { value: "converted", label: "Upgraded / paid?" },
  ],
  outreach: [
    { value: "opened", label: "Opened the last email?" },
    { value: "clicked", label: "Clicked a link?" },
    { value: "replied", label: "Replied?" },
    { value: "viewed", label: "Visited their listing page?" },
    { value: "signed_up", label: "Signed up / claimed?" },
    { value: "staged", label: "Staged a photo?" },
    { value: "converted", label: "Upgraded / paid?" },
  ],
};

const WAIT_UNITS = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
];

// Backend runs as Netlify Functions, reached through the /api/* redirect.
const FUNCTIONS_BASE = "/api";

interface EmailFlowRow {
  id: string;
  name: string;
  domain: string;
  is_active: boolean;
  trigger_type: string;
  nodes_json: any[];
  edges_json: any[];
  sender_account_id?: string | null;
  sender_group_id?: string | null;
  send_interval_seconds?: number | null;
  ignore_contacted?: boolean | null;
}

interface SenderGroup { id: string; name: string; color: string; is_default?: boolean }

interface SenderAccount {
  id: string;
  name: string;
  from_name?: string | null;
  from_email: string;
  smtp_host?: string | null;
  is_default?: boolean;
  is_active?: boolean;
  daily_limit?: number | null;
  group_id?: string | null;
}

// Multi-select for audiences: a "Select all" row plus a checkbox per audience. Used both
// in the toolbar (which audiences Start enrolls) and the trigger node config. Enrolling
// de-dupes across the picked audiences, so overlap between them is safe.
function AudienceMultiSelect({ audiences, value, onChange, className, placeholder = "Audience to send to…" }: {
  audiences: { id: string; name: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const allSelected = audiences.length > 0 && value.length === audiences.length;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const toggleAll = () => onChange(allSelected ? [] : audiences.map((a) => a.id));
  const label = value.length === 0
    ? placeholder
    : value.length === 1
      ? (audiences.find((a) => a.id === value[0])?.name || "1 audience")
      : `${value.length} audiences`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-8 justify-between gap-1.5 text-xs font-normal", className)}>
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="w-3.5 h-3.5 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="max-h-72 overflow-y-auto py-1">
          {audiences.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No audiences yet.</p>
          ) : (
            <>
              <button type="button" onClick={toggleAll} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-medium hover:bg-muted/60">
                <Checkbox checked={allSelected} className="pointer-events-none" />
                Select all ({audiences.length})
              </button>
              <div className="my-1 border-t border-border/60" />
              {audiences.map((a) => (
                <button key={a.id} type="button" onClick={() => toggle(a.id)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/60">
                  <Checkbox checked={value.includes(a.id)} className="pointer-events-none shrink-0" />
                  <span className="truncate">{a.name}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function nodeSummary(d: NodeData, templates: { id: string; name: string }[]): string {
  switch (d.kind) {
    case "trigger": return d.config.triggerKey ? (d.config.triggerLabel || d.config.triggerKey) : "— pick a trigger —";
    case "email": { const t = templates.find((x) => x.id === d.config.templateId); return t ? t.name : "— pick a template —"; }
    case "wait": return d.config.amount ? `${d.config.amount} ${d.config.unit || "days"}` : "— set a delay —";
    case "condition": return d.config.conditionKey ? `if: ${d.config.conditionLabel || d.config.conditionKey}` : "— pick a condition —";
    case "action": return d.config.label || "End of flow";
  }
}

/* ── Custom node ─────────────────────────────────────────────────────── */
function FlowNodeView({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  const meta = KINDS[d.kind];
  const Icon = meta.icon;
  const templates = (d.config.__templates as { id: string; name: string }[]) || [];
  return (
    <div className={cn("relative rounded-xl border-2 px-3 py-2 w-[200px] shadow-sm transition-shadow", meta.color, selected && "ring-2 ring-primary ring-offset-1")}>
      {typeof d.config.__count === "number" && d.config.__count > 0 && (
        <span
          className="absolute -top-2 -right-2 z-20 min-w-[20px] h-5 px-1.5 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold shadow-md"
          title={`${d.config.__count} lead${d.config.__count === 1 ? "" : "s"} here`}
        >
          {d.config.__count}
        </span>
      )}
      {d.kind !== "trigger" && <Handle type="target" position={Position.Top} className="!w-2.5 !h-2.5 !bg-foreground/40" />}
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-foreground/70 shrink-0" />
        <span className="text-xs font-semibold text-foreground truncate flex-1">{d.label || meta.label}</span>
        {d.kind === "email" && d.config.ab?.on && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); (d.config.__onStats as ((id: string) => void) | undefined)?.(id); }}
            className="nodrag nopan shrink-0 p-1 rounded-md text-foreground/45 hover:text-foreground hover:bg-foreground/10 transition-colors"
            title="A/B results"
          >
            <BarChart3 className="w-3.5 h-3.5" />
          </button>
        )}
        {d.kind === "email" && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); (d.config.__onPreview as ((id?: string, subject?: string) => void) | undefined)?.(d.config.templateId, d.config.subject); }}
            className="nodrag nopan shrink-0 -mr-0.5 p-1 rounded-md text-foreground/45 hover:text-foreground hover:bg-foreground/10 transition-colors"
            title="Preview with demo data"
          >
            <Eye className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <p className="text-[10px] text-foreground/55 mt-0.5 truncate">{nodeSummary(d, templates)}</p>
      {d.kind === "email" && (() => {
        const s = (d.config.__stats as EmailBucketStats | undefined) || emptyBucket();
        if (s.queued === 0) return <div className="mt-1 text-[9px] font-medium text-foreground/35 border-t border-foreground/10 pt-1">no sends yet</div>;
        if (s.sent === 0) return (
          <div className="mt-1 text-[9px] font-bold tabular-nums border-t border-foreground/10 pt-1 text-amber-600">
            {s.queued} queued · sending…{s.failed ? ` · ${s.failed} failed` : ""}
          </div>
        );
        const op = Math.round((s.opened / s.sent) * 100);
        const cl = Math.round((s.clicked / s.sent) * 100);
        const pg = Math.round((s.reached / s.sent) * 100);
        const rp = Math.round((s.replied / s.sent) * 100);
        const bp = Math.round((s.bounced / s.sent) * 100);
        const pending = s.queued - s.sent - s.failed;
        return (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] font-bold tabular-nums border-t border-foreground/10 pt-1">
            <span className="text-foreground/55">{s.sent} sent</span>
            <span className={heat(op, 40, 20)}>{op}% open</span>
            <span className={heat(cl, 8, 3)}>{cl}% click</span>
            <span className={heat(pg, 6, 2)}>{pg}% page</span>
            <span className={heat(rp, 5, 1)}>{s.replied} reply ({rp}%)</span>
            {s.bounced > 0 && <span className={bounceHeat(bp)}>{s.bounced} bounced ({bp}%)</span>}
            {pending > 0 && <span className="text-amber-600">{pending} pending</span>}
            {s.failed > 0 && <span className="text-red-600">{s.failed} failed</span>}
          </div>
        );
      })()}
      {d.kind === "condition" ? (
        <>
          <Handle id="yes" type="source" position={Position.Bottom} style={{ left: "28%", background: "#16a34a" }} className="!w-2.5 !h-2.5" />
          <Handle id="no" type="source" position={Position.Bottom} style={{ left: "72%", background: "#dc2626" }} className="!w-2.5 !h-2.5" />
          <span className="absolute -bottom-4 left-[18%] text-[8px] font-bold text-emerald-600">YES</span>
          <span className="absolute -bottom-4 left-[64%] text-[8px] font-bold text-red-600">NO</span>
        </>
      ) : d.kind !== "action" ? (
        <Handle type="source" position={Position.Bottom} className="!w-2.5 !h-2.5 !bg-foreground/40" />
      ) : null}
    </div>
  );
}

const nodeTypes = { flowNode: FlowNodeView };

/* ── Builder ─────────────────────────────────────────────────────────── */
function FlowBuilderInner({ domain }: { domain: Domain }) {
  const [flows, setFlows] = useState<EmailFlowRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [isActive, setIsActive] = useState(false);
  const [templates, setTemplates] = useState<{ id: string; name: string; subject?: string }[]>([]);
  const [audiences, setAudiences] = useState<{ id: string; name: string }[]>([]);
  const [senders, setSenders] = useState<SenderAccount[]>([]);
  const [senderGroups, setSenderGroups] = useState<SenderGroup[]>([]);
  const [flowSenderId, setFlowSenderId] = useState<string | null>(null);
  const [flowGroupId, setFlowGroupId] = useState<string | null>(null);
  const [flowInterval, setFlowInterval] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string; html: string } | null>(null);
  const [nodeCounts, setNodeCounts] = useState<Record<string, number>>({});
  const [enrollStats, setEnrollStats] = useState<{ total: number; active: number; completed: number } | null>(null);
  const statsBusy = useRef(false);
  const [emailStats, setEmailStats] = useState<Record<string, NodeStats>>({});
  const [statsNodeId, setStatsNodeId] = useState<string | null>(null);
  // `viewed` = unique contacts who loaded their page from one of this flow's
  // emails (a page_view event). Every flow view derives "loaded" from this same
  // signal, so the funnel, the cards, and the Sent Log always agree.
  const [funnel, setFunnel] = useState<{ enrolled: number; sent: number; opened: number; clicked: number; replied: number; viewed: number; signed: number } | null>(null);
  const [enrollAudienceIds, setEnrollAudienceIds] = useState<string[]>([]);
  const [ignoreContacted, setIgnoreContacted] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [engineOk, setEngineOk] = useState<"checking" | "ok" | "stale">("checking");
  const rf = useReactFlow();

  // Confirm the deployed engine is the current version. If not, stats and page
  // creation silently do nothing — so we surface it loudly instead of guessing.
  useEffect(() => {
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`${FUNCTIONS_BASE}/process-email-flows`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ action: "ping" }),
        });
        const r = await res.json().catch(() => ({}));
        // OK if the engine has the version/ping feature at all. Exact-version
        // matching created a redeploy treadmill, so we only require "recent enough".
        setEngineOk(r?.version ? "ok" : "stale");
      } catch { setEngineOk("stale"); }
    })();
  }, []);

  // Everything is computed from data we already have — no migration, no RPC:
  //  - where leads sit (enrollment.current_node_id)
  //  - per-email open/click (context.sentItems maps node -> queue id; join email_events)
  //  - journey funnel (unique contacts: opened -> clicked -> loaded page -> signed up)
  const loadStats = useCallback(async (flowId: string) => {
    if (statsBusy.current) return;       // heavy pass — never let refreshes overlap
    statsBusy.current = true;
    try {
    // Page through ALL enrollments. Supabase caps a single response at 1000 rows, so
    // .limit(3000) silently truncated the real count (a flow could have 2,900+). Fetch
    // in 1000-row pages so the enrolled number and the funnel reflect reality.
    const rows: any[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data } = await supabase.from("email_flow_enrollments" as any)
        .select("current_node_id,status,contact_id,context").eq("flow_id", flowId)
        .order("entered_at", { ascending: true }).range(from, from + PAGE - 1);
      const chunk = (data as any[]) || [];
      rows.push(...chunk);
      if (chunk.length < PAGE) break;
    }
    const counts: Record<string, number> = {};
    let active = 0, completed = 0;
    const qidToNode: Record<string, string> = {};
    const qidToContact: Record<string, string> = {};
    const qidToVariant: Record<string, "A" | "B"> = {};
    const contactIds: string[] = [];
    for (const r of rows) {
      counts[r.current_node_id || "__null"] = (counts[r.current_node_id || "__null"] || 0) + 1;
      if (r.status === "active") active++; else if (r.status === "completed") completed++;
      if (r.contact_id) contactIds.push(r.contact_id);
      for (const it of (r.context?.sentItems || []) as { node: string; qid: string; variant?: "A" | "B" }[]) {
        if (!it.qid) continue;
        qidToNode[it.qid] = it.node;
        if (it.variant) qidToVariant[it.qid] = it.variant;
        if (r.contact_id) qidToContact[it.qid] = r.contact_id;
      }
    }
    setNodeCounts(counts);
    setEnrollStats({ total: rows.length, active, completed });

    // Email events for the flow's sent emails.
    const qids = Object.keys(qidToNode);
    const openedQ = new Set<string>(), clickedQ = new Set<string>(), pageQ = new Set<string>(), repliedQ = new Set<string>(), bouncedQ = new Set<string>();
    for (let i = 0; i < qids.length; i += 200) {
      const { data: ev } = await supabase.from("email_events")
        .select(EVENT_SELECT).in("queue_item_id", qids.slice(i, i + 200));
      for (const e of (ev as any[]) || []) {
        if (countsAsOpen(e)) openedQ.add(e.queue_item_id);
        else if (countsAsClick(e)) clickedQ.add(e.queue_item_id);
        else if (countsAsLoad(e)) pageQ.add(e.queue_item_id);
        else if (countsAsReply(e)) repliedQ.add(e.queue_item_id);
        else if (countsAsBounce(e)) bouncedQ.add(e.queue_item_id);
      }
    }

    // Real delivery status from the queue — "sent" means the worker actually
    // handed it to the provider, not just that the flow queued it.
    const sentQ = new Set<string>(), failedQ = new Set<string>();
    for (let i = 0; i < qids.length; i += 200) {
      const { data: qq } = await supabase.from("email_queue")
        .select("id,status").in("id", qids.slice(i, i + 200));
      for (const r of (qq as any[]) || []) {
        if (r.status === "sent") sentQ.add(r.id);
        else if (r.status === "failed") failedQ.add(r.id);
      }
    }

    // Per-email node stats. queued = emails created for the node; sent = ones
    // actually sent; rates are over real sends; opens/clicks/page are subsets.
    // A/B-tagged sends are ALSO tallied into per-variant sub-buckets using the
    // exact same sets (no separate counting rules).
    const tally = (b: EmailBucketStats, qid: string) => {
      b.queued++;
      if (sentQ.has(qid)) b.sent++; else if (failedQ.has(qid)) b.failed++;
      if (openedQ.has(qid)) b.opened++;
      if (clickedQ.has(qid)) b.clicked++;
      if (pageQ.has(qid)) b.reached++;
      if (repliedQ.has(qid)) b.replied++;
      if (bouncedQ.has(qid)) b.bounced++;
    };
    const ns: Record<string, NodeStats> = {};
    for (const [qid, node] of Object.entries(qidToNode)) {
      const s: NodeStats = ns[node] || (ns[node] = emptyBucket());
      tally(s, qid);
      const v = qidToVariant[qid];
      if (v) {
        const variants = s.variants || (s.variants = { A: emptyBucket(), B: emptyBucket() });
        tally(variants[v], qid);
      }
    }
    setEmailStats(ns);

    // Journey funnel (unique contacts). "Sent" = contacts whose email actually
    // sent (not just queued). "Signed up" is the one product milestone.
    const sentC = new Set<string>(), openedC = new Set<string>(), clickedC = new Set<string>(), viewedC = new Set<string>(), repliedC = new Set<string>();
    for (const [qid, c] of Object.entries(qidToContact)) {
      if (sentQ.has(qid)) sentC.add(c);
      if (openedQ.has(qid)) openedC.add(c);
      if (clickedQ.has(qid)) clickedC.add(c);
      if (pageQ.has(qid)) viewedC.add(c);
      if (repliedQ.has(qid)) repliedC.add(c);
    }
    // The dynamic-page "signed up" funnel is a removed real-estate feature.
    const signedC = new Set<string>();
    // "viewed" = unique contacts with a page_view tied to one of this flow's emails.
    // Same underlying signal the cards and Sent Log use, so the views never disagree.
    setFunnel({ enrolled: rows.length, sent: sentC.size, opened: openedC.size, clicked: clickedC.size, replied: repliedC.size, viewed: viewedC.size, signed: signedC.size });
    } finally { statsBusy.current = false; }
  }, []);

  const addNodeAt = (kind: Kind, position: { x: number; y: number }) => {
    const id = `n_${Math.random().toString(36).slice(2, 8)}`;
    setNodes((nds) => [...nds, { id, type: "flowNode", position, data: { kind, label: KINDS[kind].label, config: {} } }]);
    setSelectedNodeId(id);
  };
  const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }, []);
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData("application/reactflow") as Kind;
    if (!kind) return;
    const position = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNodeAt(kind, position);
  }, [rf]);

  // Preview an email template rendered with demo data for the dynamic tags.
  const openPreview = useCallback(async (templateId?: string, subjectOverride?: string) => {
    if (!templateId) { toast.error("Pick a template on this email first."); return; }
    setPreviewOpen(true); setPreviewLoading(true); setPreviewData(null);
    const { table, htmlCol } = TPL[domain];
    const isOutreach = domain === "outreach";
    // Only outreach templates carry the format / tracked-image columns.
    const cols = isOutreach ? `subject,name,${htmlCol},email_format,tracking_image_url` : `subject,name,${htmlCol}`;
    const { data } = await supabase.from(table as any).select(cols).eq("id", templateId).maybeSingle();
    if (!data) { setPreviewLoading(false); toast.error("Template not found."); return; }
    const subj = subjectOverride || (data as any).subject || (data as any).name || "";
    const html = buildEmailPreviewSrcDoc({
      body: (data as any)[htmlCol] || "",
      format: isOutreach ? (data as any).email_format : "html",
      trackingImageUrl: isOutreach ? (data as any).tracking_image_url : null,
      fill: fillDemo,
    });
    setPreviewData({ subject: fillDemo(subj), html });
    setPreviewLoading(false);
  }, [domain]);

  // Open the A/B results panel for a node (the chart icon on email cards).
  const openStats = useCallback((nodeId: string) => { setSelectedNodeId(null); setStatsNodeId(nodeId); }, []);

  // Inject template list + preview/stats handlers + live enrollment count into each node.
  const decoratedNodes = useMemo(
    () => nodes.map((n) => {
      const kind = (n.data as NodeData).kind;
      const count = kind === "trigger" ? (nodeCounts["__null"] ?? 0) : (nodeCounts[n.id] ?? 0);
      return { ...n, data: { ...(n.data as NodeData), config: { ...(n.data as NodeData).config, __templates: templates, __onPreview: openPreview, __onStats: openStats, __count: count, __stats: emailStats[n.id] } } };
    }),
    [nodes, templates, openPreview, openStats, nodeCounts, emailStats],
  );

  const loadFlows = useCallback(async () => {
    setLoading(true);
    const [{ data: f }, { data: t }, { data: s }, { data: g }] = await Promise.all([
      supabase.from("email_flows" as any).select("*").eq("domain", domain).order("created_at", { ascending: false }),
      supabase.from(TPL[domain].table as any).select("id,name,subject").order("name"),
      supabase.from("email_sender_accounts").select("id,name,from_name,from_email,smtp_host,is_default,is_active,daily_limit,group_id").order("is_default", { ascending: false }),
      supabase.from("sender_groups" as any).select("id,name,color,is_default").order("created_at"),
    ]);
    setTemplates((t as any[]) || []);
    setSenders((s as any[]) || []);
    setSenderGroups((g as any[]) || []);
    if (domain === "outreach") {
      const { data: a } = await supabase.from("outreach_audiences").select("id,name").order("name");
      setAudiences((a as any[]) || []);
    }
    setFlows((f as any[]) || []);
    setLoading(false);
  }, [domain]);

  useEffect(() => { loadFlows(); }, [loadFlows]);

  // While a flow is running, refresh the live numbers every few seconds so you can
  // watch it send without clicking anything.
  useEffect(() => {
    if (!selectedId || !isActive) return;
    const id = setInterval(() => { void loadStats(selectedId); }, 12000);
    return () => clearInterval(id);
  }, [selectedId, isActive, loadStats]);

  const selectFlow = async (flow: EmailFlowRow) => {
    setSelectedId(flow.id);
    setSelectedNodeId(null);
    // Always reload the flow from the DB so a just-saved edit is never masked by
    // stale in-memory list data.
    const { data: fresh } = await supabase.from("email_flows" as any).select("*").eq("id", flow.id).maybeSingle();
    const f = ((fresh as any) || flow) as EmailFlowRow;
    setName(f.name);
    setIsActive(f.is_active);
    setFlowSenderId(f.sender_account_id ?? null);
    setFlowGroupId(f.sender_group_id ?? null);
    setFlowInterval(f.send_interval_seconds ?? null);
    setIgnoreContacted(f.ignore_contacted === true);
    const rfNodes: Node[] = (f.nodes_json || []).map((n: any) => ({
      id: n.id,
      type: "flowNode",
      position: n.position || { x: 100, y: 100 },
      data: { kind: n.type as Kind, label: n.label || KINDS[n.type as Kind]?.label || "Node", config: n.config || {} },
    }));
    const rfEdges: Edge[] = (f.edges_json || []).map((e: any) => ({
      id: e.id, source: e.source, target: e.target,
      sourceHandle: e.sourceHandle ?? null, label: e.label, animated: true,
    }));
    setNodes(rfNodes);
    setEdges(rfEdges);
    void loadStats(f.id);
    const trig = (f.nodes_json || []).find((n: any) => n.type === "trigger");
    // Remembered audiences: new array form, falling back to the old single-audience field.
    const savedIds: string[] = Array.isArray(trig?.config?.audienceIds)
      ? trig.config.audienceIds
      : (trig?.config?.audienceId ? [trig.config.audienceId] : []);
    setEnrollAudienceIds(savedIds);
  };

  const createFlow = async () => {
    const { data, error } = await supabase.from("email_flows" as any).insert({
      name: domain === "outreach" ? "New outreach flow" : "New user flow",
      domain, trigger_type: "manual", is_active: false,
      nodes_json: [{ id: "n1", type: "trigger", label: "Trigger", position: { x: 240, y: 40 }, config: {} }],
      edges_json: [],
    }).select("*").single();
    if (error) { toast.error("Couldn't create flow"); return; }
    await loadFlows();
    selectFlow(data as any);
  };

  const deleteFlow = async (flowId: string, flowName: string) => {
    if (!window.confirm(`Delete "${flowName}"? This removes the flow and its enrollments. Your email templates are kept.`)) return;
    // Clear enrollments first (in case there's no cascade), then the flow.
    await supabase.from("email_flow_enrollments" as any).delete().eq("flow_id", flowId);
    const { error } = await supabase.from("email_flows" as any).delete().eq("id", flowId);
    if (error) { toast.error("Couldn't delete the flow"); return; }
    if (selectedId === flowId) { setSelectedId(null); setSelectedNodeId(null); setNodes([]); setEdges([]); setEnrollStats(null); setNodeCounts({}); }
    await loadFlows();
    toast.success("Flow deleted");
  };

  // One-click: reuse your real "PropStream Real Estate USA 6" as the intro, seed
  // the 6 follow-ups into outreach_templates (idempotent by name), and wire the
  // full branching graph as a new PAUSED outreach flow ready to review.
  const createAgentJourney = async () => {
    setSaving(true);
    try {
      const { data: existing } = await supabase.from("outreach_templates").select("id,name");
      const rows = (existing as any[]) || [];
      const byName = new Map<string, string>(rows.map((t) => [t.name, t.id]));
      const idByKey: Record<string, string> = {};

      // Intro = your existing PropStream template, reused verbatim.
      let introId = byName.get("PropStream Real Estate USA 6") || byName.get(INTRO_FALLBACK.name);
      if (!introId) {
        const { data, error } = await supabase.from("outreach_templates")
          .insert({ name: INTRO_FALLBACK.name, subject: INTRO_FALLBACK.subject, body_html: INTRO_FALLBACK.body_html }).select("id").single();
        if (error) throw error;
        introId = (data as any).id;
      }
      idByKey["intro"] = introId!;

      // Pull the exact signature off the intro so every follow-up ends the same way.
      let signature = FALLBACK_SIG;
      try {
        const { data: introTpl } = await supabase.from("outreach_templates").select("body_html").eq("id", introId).maybeSingle();
        const extracted = extractSignature((introTpl as any)?.body_html || "");
        if (extracted) signature = extracted;
      } catch { /* keep fallback */ }

      // Follow-ups — upsert (update if present) so re-running refreshes copy + signature.
      for (const tpl of AGENT_JOURNEY_TEMPLATES) {
        const body = tpl.body_html.replace(SIG_MARK, signature);
        const existingId = byName.get(tpl.name);
        if (existingId) {
          const { error } = await supabase.from("outreach_templates").update({ subject: tpl.subject, body_html: body }).eq("id", existingId);
          if (error) throw error;
          idByKey[tpl.key] = existingId;
        } else {
          const { data, error } = await supabase.from("outreach_templates").insert({ name: tpl.name, subject: tpl.subject, body_html: body }).select("id").single();
          if (error) throw error;
          idByKey[tpl.key] = (data as any).id;
        }
      }

      const g = buildAgentJourney(idByKey);
      const { data: flow, error } = await supabase.from("email_flows" as any).insert({
        name: g.name, domain: "outreach", trigger_type: "manual_enroll", is_active: false,
        nodes_json: g.nodes, edges_json: g.edges,
      }).select("*").single();
      if (error) throw error;
      await loadFlows();
      selectFlow(flow as any);
      toast.success("Agent journey ready: PropStream intro + 7 follow-ups (your signature copied onto each). Re-run anytime to refresh the copy. Pick an audience on the trigger, Save, then flip Active.");
    } catch (err: any) {
      toast.error(err?.message || "Couldn't create the journey");
    } finally {
      setSaving(false);
    }
  };

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge({ ...c, animated: true }, eds)), [setEdges]);

  const patchNodeConfig = (patch: Record<string, any>) => {
    if (!selectedNodeId) return;
    setNodes((nds) => nds.map((n) => n.id === selectedNodeId
      ? { ...n, data: { ...(n.data as NodeData), config: { ...(n.data as NodeData).config, ...patch } } }
      : n));
  };
  const setNodeLabel = (label: string) => {
    if (!selectedNodeId) return;
    setNodes((nds) => nds.map((n) => n.id === selectedNodeId ? { ...n, data: { ...(n.data as NodeData), label } } : n));
  };
  const deleteSelectedNode = () => {
    if (!selectedNodeId) return;
    setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
  };

  const save = async (): Promise<boolean> => {
    if (!selectedId) return false;
    setSaving(true);
    const nodes_json = nodes.map((n) => {
      const d = n.data as NodeData;
      const { __templates, __onPreview, __onStats, __count, __stats, ...config } = d.config;
      return { id: n.id, type: d.kind, label: d.label, position: n.position, config };
    });
    const edges_json = edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, label: typeof e.label === "string" ? e.label : null }));
    const triggerNode = nodes.find((n) => (n.data as NodeData).kind === "trigger");
    const trigger_type = (triggerNode?.data as NodeData)?.config?.triggerKey || "manual";
    const { error } = await supabase.from("email_flows" as any).update({ name, is_active: isActive, nodes_json, edges_json, trigger_type }).eq("id", selectedId);
    setSaving(false);
    if (error) { toast.error(`Couldn't save the flow: ${error.message}`); return false; }
    toast.success("Flow saved");
    setFlows((prev) => prev.map((f) => f.id === selectedId ? { ...f, name, is_active: isActive, nodes_json, edges_json, trigger_type } : f));
    return true;
  };

  // Per-flow "send from": one mailbox OR one group, never both. Persists on its own (it
  // is a setting, not part of the canvas Save). Both null => the flow follows whatever is
  // marked default in Senders. Applies to every email queued from this flow's next run
  // onward; already-queued emails keep their sender.
  const setFlowTarget = async (value: string) => {
    if (!selectedId) return;
    const { senderId, groupId } = parseTarget(value);
    setFlowSenderId(senderId);
    setFlowGroupId(groupId);
    const { error } = await supabase
      .from("email_flows" as any)
      .update({ sender_account_id: senderId, sender_group_id: groupId })
      .eq("id", selectedId);
    if (error) { toast.error(`Couldn't change the sender: ${error.message}`); return; }
    setFlows((prev) => prev.map((f) => f.id === selectedId ? { ...f, sender_account_id: senderId, sender_group_id: groupId } : f));
    if (groupId) {
      const g = senderGroups.find((x) => x.id === groupId);
      const n = senders.filter((s) => s.group_id === groupId && s.is_active !== false).length;
      toast.success(`This flow now rotates across ${g?.name ?? "the group"} (${n} mailbox${n === 1 ? "" : "es"})`);
    } else if (senderId) {
      const picked = senders.find((s) => s.id === senderId);
      toast.success(`This flow now sends from ${picked?.from_email ?? "that mailbox"}`);
    } else {
      toast.success("This flow now uses the default sender");
    }
  };

  // How far apart this flow's emails go out. null/0 = default (hand them to the worker
  // as they're ready). A positive value drips one email every N seconds. Saves on its
  // own; applies to sends queued from the next run onward, not ones already queued.
  const setFlowIntervalValue = async (seconds: number | null) => {
    if (!selectedId) return;
    const val = seconds && seconds > 0 ? Math.round(seconds) : null;
    setFlowInterval(val);
    const { error } = await supabase.from("email_flows" as any).update({ send_interval_seconds: val }).eq("id", selectedId);
    if (error) { toast.error(`Couldn't change the pace: ${error.message}`); return; }
    setFlows((prev) => prev.map((f) => f.id === selectedId ? { ...f, send_interval_seconds: val } : f));
    toast.success(val ? `Now sending one email every ${humanInterval(val)}` : "Now sending at the default pace");
  };

  // Release the sticky mailbox on every still-running lead so the even, domain-rotating
  // assignment picks them up again on the next tick.
  const [rebalancing, setRebalancing] = useState(false);
  const rebalanceSenders = async () => {
    if (!selectedId) return;
    setRebalancing(true);
    try {
      const { error, count } = await supabase
        .from("email_flow_enrollments" as any)
        .update({ assigned_sender_account_id: null }, { count: "exact" })
        .eq("flow_id", selectedId)
        .eq("status", "active");
      if (error) throw error;
      toast.success(`Rebalanced ${count ?? 0} lead${count === 1 ? "" : "s"} — the next run spreads them evenly`);
    } catch (e: unknown) {
      toast.error("Couldn't rebalance: " + (e as Error).message);
    } finally {
      setRebalancing(false);
    }
  };

  const callEngine = async (body: Record<string, any>) => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${FUNCTIONS_BASE}/process-email-flows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(body),
    });
    return res.json().catch(() => ({ error: "request failed" }));
  };

  // Set which audiences Start enrolls, and mirror the choice onto the trigger node
  // config (array form, plus the first id in the legacy single field) so save()
  // persists it and it comes back when you reopen the flow.
  const setEnrollAudiences = (ids: string[]) => {
    setEnrollAudienceIds(ids);
    setNodes((nds) => nds.map((n) => (n.data as NodeData).kind === "trigger"
      ? { ...n, data: { ...(n.data as NodeData), config: { ...(n.data as NodeData).config, audienceIds: ids, audienceId: ids[0] || undefined } } }
      : n));
  };

  // "Send even if already contacted" — persists immediately (like the sender/speed
  // settings) so the engine reads the fresh value on the next enroll.
  const setIgnoreContactedValue = async (v: boolean) => {
    setIgnoreContacted(v);
    if (!selectedId) return;
    const { error } = await supabase.from("email_flows" as any).update({ ignore_contacted: v }).eq("id", selectedId);
    if (error) { toast.error(`Couldn't save that setting: ${error.message}`); return; }
    setFlows((prev) => prev.map((f) => f.id === selectedId ? { ...f, ignore_contacted: v } : f));
  };

  // ONE control for the whole thing. Pressing Start: saves your edits, turns the
  // flow on, enrolls the chosen audiences, and kicks the engine + sender once so
  // the first emails go out immediately. After that, the every-minute cron keeps
  // advancing and sending on its own — the tab does NOT need to stay open.
  const [starting, setStarting] = useState(false);
  const startFlow = async () => {
    if (!selectedId) return;
    setStarting(true);
    try {
      if (!(await save())) return; // save shows the real error
      await toggleActive(true);    // turn it on (persists is_active = true)

      const trig = nodes.find((n) => (n.data as NodeData).kind === "trigger");
      const trigCfg = (trig?.data as NodeData)?.config || {};
      const audienceIds = enrollAudienceIds.length
        ? enrollAudienceIds
        : (Array.isArray(trigCfg.audienceIds) ? trigCfg.audienceIds as string[] : (trigCfg.audienceId ? [trigCfg.audienceId as string] : []));
      let enrolled = 0;
      let skipped = 0;
      if (audienceIds.length) {
        const er = await callEngine({ action: "enroll", flow_id: selectedId, audience_ids: audienceIds });
        if (er.error) toast.error(`Couldn't enroll: ${er.error}`);
        else { enrolled = er.enrolled ?? 0; skipped = er.skipped ?? 0; }
      }
      // Kick once so the first emails go out right now (the cron repeats this every minute).
      const tr = await callEngine({ action: "tick" });
      const advanced = (tr.advanced ?? 0) as number;
      const fr = await fetch(`${FUNCTIONS_BASE}/process-email-queue`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }).then((r) => r.json()).catch(() => ({}));
      const sent = (fr.sent ?? fr.processed ?? 0) as number;
      if (!audienceIds.length) {
        toast.error("Pick at least one audience, then press Start flow.");
      } else if (enrolled === 0 && skipped > 0) {
        // Everyone was filtered out by the dedup guard — say so, and point at the override.
        toast.error(`Skipped ${skipped} already-contacted ${skipped === 1 ? "person" : "people"}. Turn on "Send even if already contacted" in Settings to include them.`);
      } else if (enrolled === 0 && advanced === 0 && sent === 0) {
        toast.error("Nothing to send yet. Pick an audience, then press Start flow.");
      } else {
        toast.success(`Flow running.${enrolled ? ` Enrolled ${enrolled}.` : ""}${skipped ? ` Skipped ${skipped} already-contacted.` : ""}${sent ? ` Sent ${sent} now.` : ""} The rest send automatically.`);
      }
      void loadStats(selectedId);
    } catch (e: any) {
      toast.error(`Couldn't start the flow: ${e?.message || e}`);
    } finally {
      setStarting(false);
    }
  };

  const stopFlow = async () => { await toggleActive(false); toast.success("Flow paused — nothing more will send."); };

  // Promote the winning A/B variant: make it the email's single template, turn
  // A/B off, and save. A custom (inline) winner is first saved as a real template
  // so the plain send path (which keys off templateId) can keep sending it.
  const promoteWinner = async (nodeId: string, winner: "A" | "B") => {
    const node = nodes.find((n) => n.id === nodeId);
    const ab = (node?.data as NodeData | undefined)?.config?.ab as any;
    const v = ab?.variants?.[winner];
    if (!v) { toast.error("Couldn't read the winning variant."); return; }
    let templateId: string | undefined = v.templateId;
    const subject: string | undefined = v.subject;
    if (v.source === "custom") {
      const { table, htmlCol } = TPL[domain];
      const label = (node?.data as NodeData | undefined)?.label || "Email";
      const row: Record<string, any> = { name: `${label} · A/B winner`, subject: v.subject || "", [htmlCol]: v.bodyHtml || "" };
      const { data, error } = await supabase.from(table as any).insert(row).select("id").single();
      if (error) { toast.error(`Couldn't save the winning email: ${error.message}`); return; }
      templateId = (data as any).id;
      await loadFlows(); // refresh the template list so the new one is selectable
    }
    setNodes((nds) => nds.map((n) => {
      if (n.id !== nodeId) return n;
      const d = n.data as NodeData;
      const cfg: Record<string, any> = { ...d.config };
      if (templateId) cfg.templateId = templateId;
      if (subject) cfg.subject = subject;
      cfg.ab = { ...(d.config.ab as any), on: false };
      return { ...n, data: { ...d, config: cfg } };
    }));
    setStatsNodeId(null);
    setTimeout(() => { void save(); }, 0);
  };

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const selData = selectedNode?.data as NodeData | undefined;

  const overall = Object.values(emailStats).reduce((a, s) => ({ queued: a.queued + s.queued, sent: a.sent + s.sent, failed: a.failed + s.failed, opened: a.opened + s.opened, clicked: a.clicked + s.clicked, reached: a.reached + s.reached, replied: a.replied + s.replied, bounced: a.bounced + s.bounced }), { queued: 0, sent: 0, failed: 0, opened: 0, clicked: 0, reached: 0, replied: 0, bounced: 0 });
  const overallPending = overall.queued - overall.sent - overall.failed;
  const openPct = overall.sent ? Math.round((overall.opened / overall.sent) * 100) : 0;
  const clickPct = overall.sent ? Math.round((overall.clicked / overall.sent) * 100) : 0;
  const pagePct = overall.sent ? Math.round((overall.reached / overall.sent) * 100) : 0;
  const replyPct = overall.sent ? Math.round((overall.replied / overall.sent) * 100) : 0;
  const bouncePct = overall.sent ? Math.round((overall.bounced / overall.sent) * 100) : 0;
  const statusMsg = !isActive
    ? "Paused. Pick an audience and press Start flow to turn it on and begin sending."
    : (enrollStats?.total ?? 0) === 0
      ? "Running. Pick an audience and press Start flow to add people and send."
      : `Running — ${enrollStats?.active ?? 0} moving, ${enrollStats?.completed ?? 0} finished. Sending continues automatically, tab open or not.`;

  // Persist Active immediately so it's one click, no separate Save.
  const toggleActive = async (v: boolean) => {
    setIsActive(v);
    if (selectedId) {
      await supabase.from("email_flows" as any).update({ is_active: v }).eq("id", selectedId);
      setFlows((prev) => prev.map((f) => f.id === selectedId ? { ...f, is_active: v } : f));
    }
  };

  return (
    // Fill the parent edge-to-edge. Both hosts (Outreach flows + Users flows) give
    // this a definite-height flex/scroll container, so h-full/w-full fills instead
    // of the old hardcoded h-[calc(100vh-180px)] that left a gap at the bottom/right.
    <div className="flex flex-col h-full w-full min-w-0 min-h-0 bg-card overflow-hidden">
      {engineOk === "stale" && (
        <div className="px-4 py-2 bg-red-600 text-white text-xs font-medium flex items-center gap-2 shrink-0">
          <span className="text-sm">⚠</span>
          <span>The flow engine isn't responding yet. If you just deployed, give it a moment and refresh. Flows still save; they run once the engine is reachable.</span>
        </div>
      )}
      <div className="flex flex-1 min-h-0">
      {/* Flow list */}
      <div className="w-[210px] shrink-0 border-r bg-muted/20 flex flex-col">
        <div className="p-3 border-b flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{domain === "outreach" ? "Outreach" : "User"} flows</span>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={createFlow}><Plus className="w-3.5 h-3.5" /></Button>
        </div>
        {domain === "outreach" && (
          <button
            onClick={createAgentJourney}
            disabled={saving}
            title="Seed the full agent email journey (7 emails + branching graph) as a paused flow"
            className="mx-2 mt-2 mb-1 flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            New: Agent journey
          </button>
        )}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading ? <div className="text-xs text-muted-foreground p-2">Loading…</div>
            : flows.length === 0 ? <div className="text-xs text-muted-foreground p-2">No flows yet. Hit + to create one.</div>
            : flows.map((f) => (
            <div key={f.id}
              className={cn("group flex items-center rounded-lg transition-colors", selectedId === f.id ? "bg-primary/10 border border-primary/30" : "hover:bg-muted/60 border border-transparent")}>
              <button onClick={() => selectFlow(f)} className="flex-1 min-w-0 text-left p-2.5">
                <div className="flex items-center gap-1.5">
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", f.is_active ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                  <span className="text-xs font-medium truncate">{f.name}</span>
                </div>
              </button>
              <button onClick={() => deleteFlow(f.id, f.name)} title="Delete flow"
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 p-1.5 mr-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Select or create a flow to start building.</div>
        ) : (
          <>
            <div className="px-4 py-2.5 border-b flex items-center gap-3 flex-wrap">
              <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-56 text-sm font-medium" />
              {isActive && (
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600" title="This flow is on. Emails send automatically every minute, even with this tab closed.">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                  Running
                </span>
              )}
              {/* Which mailbox or group this flow uses, surfaced when it is not the default. */}
              {flowGroupId && (() => {
                const g = senderGroups.find((x) => x.id === flowGroupId);
                if (!g) return null;
                const n = senders.filter((s) => s.group_id === g.id && s.is_active !== false).length;
                return (
                  <button onClick={() => setSettingsOpen(true)} title={`This flow rotates across the ${g.name} group. Click to change.`}
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground border rounded-full px-2 py-1 max-w-[220px]">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: g.color }} />
                    <span className="truncate">{g.name}</span>
                    <span className="text-muted-foreground/60 shrink-0">{n}</span>
                  </button>
                );
              })()}
              {!flowGroupId && flowSenderId && (() => {
                const s = senders.find((x) => x.id === flowSenderId);
                return s ? (
                  <button onClick={() => setSettingsOpen(true)} title={`This flow sends from ${s.from_email}. Click to change.`}
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground border rounded-full px-2 py-1 max-w-[200px]">
                    <Send className="w-3 h-3 shrink-0" /><span className="truncate">{s.from_email}</span>
                  </button>
                ) : null;
              })()}
              <div className="flex-1" />
              <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={() => setSettingsOpen(true)} title="Flow settings — choose which sender this flow sends from">
                <Settings className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" variant={paletteOpen ? "default" : "outline"} className="h-8 gap-1.5 text-xs" onClick={() => setPaletteOpen((o) => !o)} title="Add email/wait/condition steps to the flow">
                <Plus className="w-3.5 h-3.5" />Add steps
              </Button>
              <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={save} disabled={saving} title="Save your edits without starting">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save
              </Button>
              {domain === "outreach" && (
                <AudienceMultiSelect audiences={audiences} value={enrollAudienceIds} onChange={setEnrollAudiences} className="w-44" />
              )}
              {/* ONE button: save + turn on + enroll the chosen audience + start sending. */}
              <Button size="sm" className="h-8 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={startFlow} disabled={starting}
                title="Save, turn the flow on, enroll the chosen audience, and start sending now. It keeps running on its own after you close this tab.">
                {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}{starting ? "Starting…" : isActive ? "Start / add audience" : "Start flow"}
              </Button>
              {isActive && (
                <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs text-muted-foreground" onClick={stopFlow} title="Pause the flow — stops all sending">
                  <Pause className="w-3.5 h-3.5" />Pause
                </Button>
              )}
            </div>

            {/* Flow settings: per-flow sender (and room for more later). */}
            <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2"><Settings className="w-4 h-4" />Flow settings</DialogTitle>
                  <DialogDescription>Settings for "{name}". They apply to this flow only.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-1">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Send from</label>
                    <Select value={targetValue(flowSenderId, flowGroupId)} onValueChange={setFlowTarget}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={TARGET_DEFAULT}>Default (recommended)</SelectItem>
                        {senderGroups.length > 0 && (
                          <SelectGroup>
                            <SelectLabel>Groups — rotate across mailboxes</SelectLabel>
                            {senderGroups.map((g) => {
                              const n = senders.filter((s) => s.group_id === g.id && s.is_active !== false).length;
                              return (
                                <SelectItem key={g.id} value={`group:${g.id}`}>
                                  <span className="inline-flex items-center gap-2">
                                    <span className="w-2 h-2 rounded-full" style={{ background: g.color }} />
                                    {g.name} · {n} mailbox{n === 1 ? "" : "es"}{g.is_default ? " (default)" : ""}
                                  </span>
                                </SelectItem>
                              );
                            })}
                          </SelectGroup>
                        )}
                        <SelectGroup>
                          <SelectLabel>Single mailbox</SelectLabel>
                          {senders.map((s) => (
                            <SelectItem key={s.id} value={`sender:${s.id}`}>
                              {s.from_email}{s.is_default ? " (default)" : ""}{s.is_active === false ? " · paused" : ""}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Pick one mailbox, or a group to rotate across every mailbox in it (each lead keeps the same sender for the whole sequence). Leave it on Default to follow whatever is marked default in Senders. Changing it affects emails sent from now on, not ones already queued. It saves immediately.
                    </p>
                  </div>

                  {/* Send pacing — how far apart this flow's emails leave the queue. */}
                  <div className="space-y-1.5 pt-1 border-t border-border/60">
                    <label className="text-sm font-medium pt-2 block">Send speed</label>
                    <Select
                      value={flowInterval && !INTERVAL_PRESETS.some((p) => p.value === flowInterval) ? "__custom__" : String(flowInterval ?? "__default__")}
                      onValueChange={(v) => { if (v === "__custom__") { setFlowIntervalValue(flowInterval || 90); return; } setFlowIntervalValue(v === "__default__" ? null : Number(v)); }}
                    >
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {INTERVAL_PRESETS.map((p) => (
                          <SelectItem key={p.label} value={p.value === null ? "__default__" : String(p.value)}>{p.label}</SelectItem>
                        ))}
                        <SelectItem value="__custom__">Custom…</SelectItem>
                      </SelectContent>
                    </Select>
                    {flowInterval != null && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">One email every</span>
                        <Input
                          type="number" min={1} className="h-8 w-20 text-sm"
                          value={flowInterval}
                          onChange={(e) => setFlowInterval(Math.max(1, Number(e.target.value) || 1))}
                          onBlur={(e) => setFlowIntervalValue(Math.max(1, Number(e.target.value) || 1))}
                        />
                        <span className="text-xs text-muted-foreground">seconds ({humanInterval(flowInterval)})</span>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {flowInterval
                        ? `This flow drips out one email every ${humanInterval(flowInterval)}. They still queue all at once, they just leave one at a time — good for warming a new mailbox.`
                        : "Default: emails are handed to the sender as soon as they're ready. Set a gap to drip them out slowly instead."}
                    </p>
                  </div>

                  {/* Override the global dedup guard for this flow. */}
                  <div className="space-y-1.5 pt-1 border-t border-border/60">
                    <div className="flex items-center justify-between pt-2">
                      <label className="text-sm font-medium">Send even if already contacted</label>
                      <Switch checked={ignoreContacted} onCheckedChange={setIgnoreContactedValue} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Off (recommended): people already active in another flow, or emailed anywhere in the last 30 days, are skipped so nobody gets the same outreach twice. On: everyone in the picked audiences is enrolled regardless of history. It still never doubles a person within this one flow. Saves immediately.
                    </p>
                  </div>
                  {flowGroupId && (() => {
                    const g = senderGroups.find((x) => x.id === flowGroupId);
                    if (!g) return null;
                    const members = senders.filter((s) => s.group_id === g.id);
                    const active = members.filter((s) => s.is_active !== false);
                    const capacity = active.reduce((n, s) => n + (s.daily_limit ?? 50), 0);
                    return (
                      <div className="rounded-md border bg-muted/30 p-2.5 text-xs space-y-1.5">
                        <div className="flex items-center gap-1.5 font-medium">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: g.color }} />{g.name}
                        </div>
                        {members.length === 0 ? (
                          <div className="text-amber-600">This group is empty. Add mailboxes to it in the Senders tab, or this flow will not send.</div>
                        ) : (
                          <>
                            <div className="text-muted-foreground">{active.length} active of {members.length} · up to {capacity} sends a day</div>
                            <div className="space-y-0.5">
                              {members.map((s) => (
                                <div key={s.id} className="flex items-center justify-between gap-2">
                                  <span className={cn("truncate", s.is_active === false && "text-muted-foreground line-through")}>{s.from_email}</span>
                                  <span className="text-muted-foreground/70 shrink-0">{s.daily_limit ?? 50}/day</span>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}
                  {!flowGroupId && flowSenderId && (() => {
                    const s = senders.find((x) => x.id === flowSenderId);
                    if (!s) return null;
                    const isSes = /amazonaws|amazon|ses/i.test(s.smtp_host || "");
                    return (
                      <div className="rounded-md border bg-muted/30 p-2.5 text-xs space-y-1">
                        <div className="flex items-center gap-1.5 font-medium"><Send className="w-3 h-3 shrink-0" />{(s.from_name || s.name)} &lt;{s.from_email}&gt;</div>
                        <div className="text-muted-foreground">{s.smtp_host || "no SMTP host set"}</div>
                        {!isSes && (
                          <div className="text-amber-600">Heads up: this is not an Amazon SES account, so it will not use your SES deliverability.</div>
                        )}
                      </div>
                    );
                  })()}
                  {senders.length === 0 && (
                    <p className="text-xs text-amber-600">No sender accounts found. Add one in the Senders tab first.</p>
                  )}
                  {senders.length > 0 && senderGroups.length === 0 && (
                    <p className="text-xs text-muted-foreground">No groups yet. Create one in Senders to rotate across several mailboxes.</p>
                  )}

                  {/* Each lead keeps the mailbox it was first assigned, for the whole
                      sequence. That is right for a conversation, but it also means leads
                      assigned by an older/uneven rotation stay stuck on those mailboxes —
                      which is how one mailbox hits its daily cap while another sits at 0.
                      This releases the not-yet-finished leads so the even rotation
                      reassigns them on the next run. */}
                  <div className="space-y-1.5 pt-1 border-t border-border/60">
                    <label className="text-sm font-medium pt-2 block">Even out the mailboxes</label>
                    <Button size="sm" variant="outline" className="gap-1.5" disabled={rebalancing} onClick={rebalanceSenders}>
                      {rebalancing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      {rebalancing ? "Rebalancing…" : "Rebalance senders"}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Clears the mailbox assigned to every lead still running in this flow, so the next run spreads them evenly across the group's domains again. Leads that already replied or finished are untouched.
                    </p>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            {/* Status line — tells you what's happening and what to do next */}
            <div className={cn("px-4 py-1.5 border-b text-[11px] font-medium flex items-center gap-2",
              !isActive ? "bg-amber-50 text-amber-800" : (enrollStats?.total ?? 0) === 0 ? "bg-blue-50 text-blue-800" : "bg-emerald-50 text-emerald-800")}>
              <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", !isActive ? "bg-amber-500" : (enrollStats?.total ?? 0) === 0 ? "bg-blue-500" : "bg-emerald-500")} />
              {statusMsg}
            </div>

            {/* Journey funnel — unique people at each stage (incl. who loaded the page) */}
            {funnel && funnel.enrolled > 0 && (
              <div className="px-4 py-2 border-b bg-card flex items-center gap-1 overflow-x-auto">
                <span className="text-[9px] font-bold uppercase leading-tight tracking-wide text-muted-foreground/70 mr-1.5 shrink-0">People<br />journey</span>
                {(([
                  { label: "Enrolled", n: funnel.enrolled, c: "text-slate-600" },
                  { label: "Opened", n: funnel.opened, c: "text-blue-600" },
                  { label: "Clicked", n: funnel.clicked, c: "text-violet-600" },
                  { label: "Replied", n: funnel.replied, c: "text-rose-600", tip: "Unique contacts who replied, attributed to a specific email this flow sent them." },
                  { label: "Loaded page", n: funnel.viewed, c: "text-amber-600", tip: "People who loaded their landing page from one of this flow's emails. Same page_view signal the cards and Sent Log use." },
                  { label: "Signed up", n: funnel.signed, c: "text-emerald-600" },
                ] as { label: string; n: number; c: string; sub?: string; tip?: string }[])).map((s, i, arr) => {
                  const pct = funnel.enrolled ? Math.round((s.n / funnel.enrolled) * 100) : 0;
                  return (
                    <div key={s.label} className="flex items-center gap-1 shrink-0">
                      <div className="min-w-[86px] rounded-lg border bg-muted/10 px-2 py-1.5 text-center" title={s.tip}>
                        <div className={cn("text-base font-bold tabular-nums leading-none", s.c)}>{s.n}</div>
                        <div className="text-[9px] text-muted-foreground mt-1">{s.label}</div>
                        <div className="text-[9px] font-semibold text-muted-foreground/70">{pct}%</div>
                        {s.sub && <div className="text-[8px] text-muted-foreground/60 mt-0.5 leading-tight">{s.sub}</div>}
                      </div>
                      {i < arr.length - 1 && <span className="text-muted-foreground/30 text-base px-0.5 shrink-0">›</span>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Numbers: where leads are + how the emails are performing */}
            {enrollStats && (
              <div className="px-4 py-1.5 border-b bg-muted/20 flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                <span><b className="text-foreground">{enrollStats.total}</b> enrolled</span>
                <span><b className="text-amber-600">{enrollStats.active}</b> in progress</span>
                <span><b className="text-emerald-600">{enrollStats.completed}</b> finished</span>
                <span className="text-foreground/25">|</span>
                <span><b className="text-emerald-600">{overall.sent}</b> sent</span>
                <span title="Queued and waiting to go out. These send automatically every minute once the flow is running."><b className={overallPending > 0 ? "text-amber-600" : "text-foreground/40"}>{overallPending}</b> in queue</span>
                {overall.failed > 0 && <span><b className="text-red-600">{overall.failed}</b> failed</span>}
                {overall.sent > 0 && (
                  <>
                    <span className={heat(openPct, 40, 20)}><b>{openPct}%</b> open</span>
                    <span className={heat(clickPct, 8, 3)}><b>{clickPct}%</b> click</span>
                    <span className={heat(replyPct, 5, 1)} title="Recipients who replied, attributed to a specific email this flow sent. Auto-replies and bounces are excluded."><b>{overall.replied}</b> reply ({replyPct}%)</span>
                    {overall.bounced > 0 && <span className={bounceHeat(bouncePct)} title="Hard bounces reported by Amazon SES (address doesn't exist / can't receive). These are suppressed so they won't be re-sent."><b>{overall.bounced}</b> bounced ({bouncePct}%)</span>}
                    <span className={heat(pagePct, 6, 2)} title="Emails whose landing page loaded (a page_view tied to that email). Same signal the cards and Sent Log use."><b>{pagePct}%</b> page</span>
                  </>
                )}
                <span className="text-muted-foreground/60">badge = leads here · email nodes show open/click</span>
                <button onClick={() => selectedId && loadStats(selectedId)} className="ml-auto flex items-center gap-1 hover:text-foreground transition-colors" title="Refresh stats">
                  <RefreshCw className="w-3 h-3" /> refresh
                </button>
              </div>
            )}

            <div className="flex-1 relative">
              <ReactFlow
                nodes={decoratedNodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_, n) => { setStatsNodeId(null); setSelectedNodeId(n.id); }}
                onPaneClick={() => { setSelectedNodeId(null); setStatsNodeId(null); }}
                onDragOver={onDragOver}
                onDrop={onDrop}
                nodeTypes={nodeTypes}
                fitView
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={18} size={1.5} color="hsl(30 10% 80%)" />
                <Controls showInteractive={false} />
                <MiniMap pannable zoomable className="!bg-muted/40" />
              </ReactFlow>

              {/* Step palette — open/close, drag onto canvas (or click to drop) */}
              {paletteOpen && (
                <div className="absolute top-3 right-3 z-10 w-44 rounded-xl border bg-card shadow-lg p-2">
                  <div className="flex items-center justify-between px-1 pb-1.5 mb-1 border-b">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Add steps</span>
                    <button onClick={() => setPaletteOpen(false)} className="text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
                  </div>
                  <p className="text-[10px] text-muted-foreground px-1 mb-1.5">Drag onto the canvas, or click to drop one.</p>
                  {(["trigger", "email", "wait", "condition", "action"] as Kind[]).map((k) => {
                    const Icon = KINDS[k].icon;
                    return (
                      <div
                        key={k}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.setData("application/reactflow", k); e.dataTransfer.effectAllowed = "move"; }}
                        onClick={() => addNodeAt(k, rf.screenToFlowPosition({ x: 360, y: 240 }))}
                        className={cn("flex items-center gap-2 px-2.5 py-2 mb-1 rounded-lg border-2 cursor-grab active:cursor-grabbing text-xs font-medium select-none", KINDS[k].color)}
                      >
                        <Icon className="w-3.5 h-3.5" />{KINDS[k].label}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Node config panel */}
      {selData && (
        <div className="w-[280px] shrink-0 border-l bg-card flex flex-col">
          <div className="p-3 border-b flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{KINDS[selData.kind].label}</span>
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" onClick={deleteSelectedNode}><Trash2 className="w-3.5 h-3.5" /></Button>
          </div>
          <div className="p-3 space-y-4 overflow-y-auto">
            <Field label="Label">
              <Input value={selData.label} onChange={(e) => setNodeLabel(e.target.value)} className="h-9 text-sm" />
            </Field>

            {selData.kind === "trigger" && (
              <Field label="When this happens">
                <Select value={selData.config.triggerKey || ""} onValueChange={(v) => {
                  const opt = TRIGGERS[domain].find((o) => o.value === v);
                  patchNodeConfig({ triggerKey: v, triggerLabel: opt?.label });
                }}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Pick a trigger…" /></SelectTrigger>
                  <SelectContent>{TRIGGERS[domain].map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                </Select>
                {selData.config.triggerKey === "manual_enroll" && domain === "outreach" && (
                  <div className="mt-2">
                    <AudienceMultiSelect audiences={audiences} value={enrollAudienceIds} onChange={setEnrollAudiences} className="w-full" placeholder="Audiences to enroll…" />
                    <p className="mt-1 text-[11px] text-muted-foreground">Pick one or more. The same set is used by the Start button.</p>
                  </div>
                )}
              </Field>
            )}

            {selData.kind === "email" && (() => {
              const ab = selData.config.ab as any | undefined;
              const on = !!ab?.on;
              const patchAb = (p: Record<string, any>) => patchNodeConfig({ ab: { ...(ab || {}), ...p } });
              const patchVariant = (key: "A" | "B", p: Record<string, any>) =>
                patchAb({ variants: { ...(ab?.variants || {}), [key]: { ...(ab?.variants?.[key] || {}), ...p } } });
              return (
                <>
                  {/* A/B master toggle */}
                  <div className="flex items-center justify-between rounded-lg border p-2.5">
                    <div>
                      <p className="text-xs font-semibold flex items-center gap-1.5"><BarChart3 className="w-3.5 h-3.5" /> A/B test this email</p>
                      <p className="text-[10px] text-muted-foreground/70">Send two versions, keep the winner.</p>
                    </div>
                    <Switch checked={on} onCheckedChange={(checked) => patchAb({
                      on: checked,
                      testSize: ab?.testSize ?? 100,
                      metric: ab?.metric ?? "click",
                      variants: {
                        A: ab?.variants?.A ?? { source: "template", templateId: selData.config.templateId, subject: selData.config.subject },
                        B: ab?.variants?.B ?? { source: "template" },
                      },
                    })} />
                  </div>

                  {!on ? (
                    <>
                      <Field label="Email template">
                        <Select value={selData.config.templateId || ""} onValueChange={(v) => {
                          const tpl = templates.find((t) => t.id === v);
                          patchNodeConfig({ templateId: v, subject: tpl?.subject || tpl?.name || selData.config.subject || "" });
                        }}>
                          <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Pick a template…" /></SelectTrigger>
                          <SelectContent>{templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
                        </Select>
                        {selData.config.templateId && (
                          <button type="button" onClick={() => openPreview(selData.config.templateId, selData.config.subject)} className="mt-2 flex items-center gap-1.5 text-xs text-primary hover:underline">
                            <Eye className="w-3.5 h-3.5" /> Preview with demo data
                          </button>
                        )}
                      </Field>
                      <Field label="Subject" hint="Auto-filled from the template — edit to override. Supports {{first_name}}, {{city}}…">
                        <Input value={selData.config.subject || ""} onChange={(e) => patchNodeConfig({ subject: e.target.value })} placeholder="Subject line…" className="h-9 text-sm" />
                      </Field>
                    </>
                  ) : (
                    <>
                      <VariantEditor title="Variant A" v={ab?.variants?.A || {}} onChange={(p) => patchVariant("A", p)} templates={templates} onPreview={openPreview} />
                      <VariantEditor title="Variant B" v={ab?.variants?.B || {}} onChange={(p) => patchVariant("B", p)} templates={templates} onPreview={openPreview} />
                      <Field label="How it splits">
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          Sends <b className="text-foreground">50/50 continuously</b> — every send alternates so A and B keep equal volume (compare the rates on the chart icon, not the totals). When a winner is clear, hit <b className="text-foreground">Promote winner</b> on the card and the rest send as the winner.
                        </p>
                      </Field>
                      {(!resolvableVariant(ab?.variants?.A) || !resolvableVariant(ab?.variants?.B)) && (
                        <p className="text-[10px] text-amber-600">Set both Variant A and Variant B (a template, or write your own) before starting.</p>
                      )}
                    </>
                  )}
                </>
              );
            })()}

            {selData.kind === "wait" && (
              <Field label="Wait">
                <div className="flex gap-2">
                  <Input type="number" min={1} value={selData.config.amount || ""} onChange={(e) => patchNodeConfig({ amount: Number(e.target.value) })} className="h-9 text-sm w-20" />
                  <Select value={selData.config.unit || "days"} onValueChange={(v) => patchNodeConfig({ unit: v })}>
                    <SelectTrigger className="h-9 text-sm flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>{WAIT_UNITS.map((u) => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </Field>
            )}

            {selData.kind === "condition" && (
              <Field label="Branch on" hint="Connect YES / NO outputs to next steps">
                <Select value={selData.config.conditionKey || ""} onValueChange={(v) => {
                  const opt = CONDITIONS[domain].find((o) => o.value === v);
                  patchNodeConfig({ conditionKey: v, conditionLabel: opt?.label });
                }}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Pick a condition…" /></SelectTrigger>
                  <SelectContent>{CONDITIONS[domain].map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            )}

            {selData.kind === "action" && (
              <Field label="Goal label">
                <Input value={selData.config.label || ""} onChange={(e) => patchNodeConfig({ label: e.target.value })} placeholder="e.g. Signed up" className="h-9 text-sm" />
              </Field>
            )}
          </div>
        </div>
      )}

      {/* A/B results panel — opened by the chart icon on an email card */}
      {statsNodeId && (() => {
        const n = nodes.find((x) => x.id === statsNodeId);
        return n ? <StatsPanel node={n} stats={emailStats[n.id]} onPromote={promoteWinner} onClose={() => setStatsNodeId(null)} /> : null;
      })()}

      </div>{/* end inner flex */}

      {/* Email preview — rendered with demo data for the dynamic tags */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl w-[95vw] max-h-[90vh] overflow-hidden flex flex-col p-0">
          <DialogHeader className="px-5 pt-5 pb-3 border-b">
            <DialogTitle className="flex items-center gap-2 text-base"><Eye className="w-4 h-4" /> Email preview</DialogTitle>
            <DialogDescription className="text-xs">Dynamic tags filled with sample data (e.g. Sarah Chen · 1428 Maple Avenue, Austin).</DialogDescription>
          </DialogHeader>
          <div className="px-5 py-3 border-b bg-muted/30">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Subject</p>
            <p className="text-sm font-medium break-words">{previewData?.subject || "—"}</p>
          </div>
          <div className="flex-1 overflow-hidden bg-[#f6f5f3]">
            {previewLoading ? (
              <div className="p-10 text-center text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>
            ) : (
              <iframe title="Email preview" srcDoc={previewData?.html || ""} className="w-full h-[60vh] border-0 bg-white" sandbox="" />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// One A/B variant editor: pick a saved template OR write your own subject + body.
function VariantEditor({ title, v, onChange, templates, onPreview }: {
  title: string;
  v: { source?: "template" | "custom"; templateId?: string; subject?: string; bodyHtml?: string };
  onChange: (p: Partial<{ source: "template" | "custom"; templateId: string; subject: string; bodyHtml: string }>) => void;
  templates: { id: string; name: string; subject?: string }[];
  onPreview: (id?: string, subject?: string) => void;
}) {
  const source = v.source || "template";
  return (
    <div className="rounded-lg border p-2.5 space-y-3">
      <p className="text-xs font-semibold">{title}</p>
      <RadioGroup value={source} onValueChange={(val) => onChange({ source: val as "template" | "custom" })} className="flex gap-4">
        <label className="flex items-center gap-1.5 text-xs cursor-pointer"><RadioGroupItem value="template" /> Saved template</label>
        <label className="flex items-center gap-1.5 text-xs cursor-pointer"><RadioGroupItem value="custom" /> Write my own</label>
      </RadioGroup>
      {source === "template" ? (
        <Field label="Template">
          <Select value={v.templateId || ""} onValueChange={(val) => {
            const tpl = templates.find((t) => t.id === val);
            onChange({ templateId: val, subject: tpl?.subject || tpl?.name || v.subject || "" });
          }}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Pick a template…" /></SelectTrigger>
            <SelectContent>{templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
          </Select>
          {v.templateId && (
            <button type="button" onClick={() => onPreview(v.templateId, v.subject)} className="mt-2 flex items-center gap-1.5 text-xs text-primary hover:underline">
              <Eye className="w-3.5 h-3.5" /> Preview
            </button>
          )}
        </Field>
      ) : (
        <>
          <Field label="Subject">
            <Input value={v.subject || ""} onChange={(e) => onChange({ subject: e.target.value })} placeholder="Subject line…" className="h-9 text-sm" />
          </Field>
          <Field label="Body" hint="HTML allowed. Supports {{first_name}}, {{city}}…">
            <Textarea value={v.bodyHtml || ""} onChange={(e) => onChange({ bodyHtml: e.target.value })} placeholder="<p>Hi {{first_name}}…</p>" className="text-sm min-h-[120px] font-mono" />
          </Field>
        </>
      )}
    </div>
  );
}

function StatsRow({ s }: { s: EmailBucketStats }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-bold tabular-nums">
      <span className="text-muted-foreground">{s.sent} sent</span>
      <span className={heat(abRate(s.opened, s.sent), 40, 20)}>{abRate(s.opened, s.sent)}% open</span>
      <span className={heat(abRate(s.clicked, s.sent), 8, 3)}>{abRate(s.clicked, s.sent)}% click</span>
      <span className={heat(abRate(s.replied, s.sent), 5, 1)}>{s.replied} reply ({abRate(s.replied, s.sent)}%)</span>
      {s.bounced > 0 && <span className={bounceHeat(abRate(s.bounced, s.sent))}>{s.bounced} bounced ({abRate(s.bounced, s.sent)}%)</span>}
      <span className={heat(abRate(s.reached, s.sent), 6, 2)}>{abRate(s.reached, s.sent)}% page</span>
    </div>
  );
}

// Right-side stats panel opened by the chart icon. Two-variant comparison for A/B
// emails (with a promote-winner button), single row otherwise.
function StatsPanel({ node, stats, onPromote, onClose }: {
  node: Node;
  stats?: NodeStats;
  onPromote: (nodeId: string, winner: "A" | "B") => void;
  onClose: () => void;
}) {
  const d = node.data as NodeData;
  const ab = d.config?.ab as any | undefined;
  let body: React.ReactNode;
  if (ab?.on && stats?.variants) {
    const va = stats.variants.A, vb = stats.variants.B;
    // Reply-first winner with fallback. Reply rate is the most meaningful signal but
    // the sparsest, so it only decides once BOTH variants have a real sample (>= MIN_SENT
    // sends) AND there are enough replies combined (>= MIN_REPLIES); otherwise it falls
    // through to click rate, then open rate. Ties keep A (matches prior behavior), so one
    // lucky reply on a tiny cohort can't flip the winner.
    const MIN_SENT = 20, MIN_REPLIES = 3;
    const enoughSent = va.sent >= MIN_SENT && vb.sent >= MIN_SENT;
    const pick = (partA: number, partB: number, minEvents: number) =>
      partA + partB < minEvents ? 0 : Math.sign(abRate(partB, vb.sent) - abRate(partA, va.sent));
    let decided = enoughSent ? pick(va.replied, vb.replied, MIN_REPLIES) : 0;
    let by = decided !== 0 ? "reply" : "";
    if (decided === 0) { decided = pick(va.clicked, vb.clicked, 1); if (decided !== 0) by = "click"; }
    if (decided === 0) { decided = pick(va.opened, vb.opened, 1); if (decided !== 0) by = "open"; }
    const winner: "A" | "B" | null = va.sent + vb.sent === 0 ? null : (decided > 0 ? "B" : "A");
    body = (
      <div className="space-y-3">
        <p className="text-[10px] text-muted-foreground/70">Winner by reply rate first, then click, then open{by ? ` (decided on ${by} rate)` : ""}. Promote sends it to everyone left.</p>
        {(["A", "B"] as const).map((k) => {
          const s = stats.variants![k];
          const isWin = winner === k;
          return (
            <div key={k} className={cn("rounded-lg border p-3", isWin && "border-emerald-500 bg-emerald-50/50")}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold">Variant {k}{isWin && " · winner"}</span>
              </div>
              <StatsRow s={s} />
            </div>
          );
        })}
        <Button size="sm" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white" disabled={!winner} onClick={() => winner && onPromote(node.id, winner)}>
          Promote winner{winner ? ` (Variant ${winner})` : ""}
        </Button>
      </div>
    );
  } else {
    body = stats && stats.queued > 0 ? <StatsRow s={stats} /> : <p className="text-xs text-muted-foreground">No sends yet.</p>;
  }
  return (
    <div className="w-[300px] shrink-0 border-l bg-card flex flex-col">
      <div className="p-3 border-b flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5"><BarChart3 className="w-3.5 h-3.5" /> {d.label || "Email"} stats</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
      </div>
      <div className="p-3 overflow-y-auto">{body}</div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] font-medium text-muted-foreground block mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground/70 mt-1">{hint}</p>}
    </div>
  );
}

export default function FlowBuilder({ domain }: { domain: Domain }) {
  return (
    <ReactFlowProvider>
      <FlowBuilderInner domain={domain} />
    </ReactFlowProvider>
  );
}
