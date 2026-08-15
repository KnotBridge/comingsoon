import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { fetchSenderTargets, type GroupLite, type SenderLite } from "./senderTargets";
import { supabase } from "@/integrations/supabase/client";
import { invokeFn } from "@/integrations/functions";
import { toast } from "sonner";
import { Send, Mail, RefreshCw, X, PenSquare, Loader2, Eye, MousePointerClick, Tag as TagIcon, Plus, SlidersHorizontal, Archive, ArchiveRestore, FileText, User, Inbox, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import { isBot } from "../flows/metrics";
import { queueAndSend } from "./sendMail";
import RichComposer from "./RichComposer";
import ContactProfilePanel from "./ContactProfilePanel";

// A real inbox built from our own data (mailbox_messages). Open/click tracking +
// insights, colored tags, one-click follow-up. The conversation reads top-to-bottom
// like Outlook; the body renders inline (no iframe) so it flows to full height and the
// whole pane scrolls; each message collapses to just its header on click.

interface MailMessage {
  id: string;
  direction: "inbound" | "outbound";
  thread_key: string | null;
  message_id: string | null;
  queue_item_id: string | null;
  contact_id: string | null;
  from_email: string | null;
  from_name: string | null;
  to_email: string | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  snippet: string | null;
  occurred_at: string;
  seen: boolean;
  archived_at: string | null;
  // Set only on the optimistic rows we synthesise for a send in flight. Absent on
  // everything that came out of the database.
  pending?: "sending" | "failed";
  pendingError?: string;
}

// Which inbox (or group of inboxes) the Mailbox is showing. Persisted, because this is a
// view you set once and expect to still be there tomorrow, not something to re-pick on
// every refresh. Only mailboxes with IMAP on can be scoped to: no IMAP means no inbox.
const SCOPE_KEY = "renov.mailbox.scope";
function loadScope(): string {
  try { return localStorage.getItem(SCOPE_KEY) || "all"; } catch { return "all"; }
}
function saveScope(v: string) {
  try { localStorage.setItem(SCOPE_KEY, v); } catch { /* private mode: the view just won't stick */ }
}

interface Thread {
  key: string;
  messages: MailMessage[];
  latest: MailMessage;
  counterparty: string;
  counterpartyName: string;
  subject: string;
  unread: number;
  hasInbound: boolean;
  hasOutbound: boolean;
  archived: boolean;
  ourAddress: string | null; // which of our sender addresses this conversation is on
  warmup: boolean;     // warmup peer ("Phone_N0:") — hidden by the toggle
  vendorSpam: boolean; // from the warmup tool (trulyinbox) — always hidden
}

// Two kinds of warmup traffic, hidden differently:
//  - Vendor spam: mail from the warmup tool itself (trulyinbox). This is never a
//    prospect, so it is ALWAYS hidden, whatever the toggle says.
//  - Warmup peers: the pool signs every message with a "Phone_N0:" line. This is hidden
//    by default but the toggle can reveal it (you might want to inspect it).
const WARMUP_RE = /Phone_N0\s*:/i;
const VENDOR_RE = /trulyinbox/i;
function isVendorSpam(m: MailMessage): boolean {
  return VENDOR_RE.test(m.from_email || "") || VENDOR_RE.test(m.to_email || "");
}
function isWarmupPeer(m: MailMessage): boolean {
  return WARMUP_RE.test(m.body_text || "") || WARMUP_RE.test(m.body_html || "") || WARMUP_RE.test(m.snippet || "");
}
const HIDE_WARMUP_KEY = "renov.mailbox.hideWarmup";

interface Track { opens: number; lastOpen: string | null; clicks: number; lastClick: string | null }
interface Insight { opens: number; clicks: number; opened: boolean; clicked: boolean; waiting: boolean; waitingDays: number | null; replied: boolean }
interface Tag { id: string; label: string; color: string }

const TAG_COLORS = ["#ef4444", "#f59e0b", "#eab308", "#22c55e", "#10b981", "#3b82f6", "#6366f1", "#a855f7", "#ec4899", "#6b7280"];

// Inbound replies load in full (few). Outbound is paged and grown by scrolling, so a
// burst of flow sends never buries older conversations or the replies.
const OUTBOUND_PAGE = 800;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Prepare an email body for an isolated iframe: keep its own <style> (it renders
// correctly, and the styles stay scoped to the iframe, not the app), but strip the
// html/head/body wrappers, scripts, inline event handlers, javascript: links, and our
// own tracking (so the admin opening an email does not fire the open pixel).
function sanitizeForIframe(html: string): string {
  return html
    .replace(/<img[^>]*track-open[^>]*>/gi, "")
    .replace(/href="[^"]*\/track-click\?[^"]*"/gi, (m) => { const u = m.match(/[?&]u=([^"&]+)/); try { return u ? `href="${decodeURIComponent(u[1])}"` : `href="#"`; } catch { return `href="#"`; } })
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(?:html|head|body|!doctype)[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"');
}

const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
function dateBucket(iso: string): string {
  const d = new Date(iso), now = new Date();
  const diff = Math.round((+startOfDay(now) - +startOfDay(d)) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "Earlier this week";
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "This month";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function shortTime(iso: string): string {
  const d = new Date(iso), now = new Date();
  const diff = Math.round((+startOfDay(now) - +startOfDay(d)) / 86400000);
  if (diff <= 0) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function cleanBody(raw: string | null): string {
  if (!raw) return "";
  let s = raw.replace(/\r/g, "");
  const looksRaw = /^\*\s*\d+\s+FETCH/im.test(s) || /RFC822\s*\{\d+\}/.test(s) ||
    /^(Return-Path|Received|Authentication-Results|MIME-Version):/im.test(s);
  if (!looksRaw) return s.trim();
  const bm = s.match(/boundary="?([^"\n;]+)"?/i);
  if (bm) {
    const b = bm[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const part of s.split(new RegExp("--" + b))) {
      if (/Content-Type:\s*text\/plain/i.test(part)) {
        let seg = part.split(/\n\n/).slice(1).join("\n\n");
        if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(part))
          seg = seg.replace(/=\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
        return seg.replace(/\n{3,}/g, "\n\n").trim().slice(0, 5000);
      }
    }
  }
  const i = s.indexOf("\n\n");
  if (i >= 0) s = s.slice(i + 2);
  s = s.replace(/^\s*[A-Z]?\d+\s+(OK|NO|BAD)\b.*$/im, "").replace(/\)\s*$/, "");
  return s.replace(/\n{3,}/g, "\n\n").trim().slice(0, 5000);
}
function listSnippet(m: MailMessage): string {
  const c = cleanBody(m.body_text).replace(/\s+/g, " ").trim();
  return (c || m.snippet || "").slice(0, 140);
}

function threadInsight(t: Thread, tracks: Record<string, Track>): Insight {
  let opens = 0, clicks = 0;
  for (const m of t.messages) {
    const tr = m.direction === "outbound" && m.queue_item_id ? tracks[m.queue_item_id] : null;
    if (tr) { opens += tr.opens; clicks += tr.clicks; }
  }
  const rev = [...t.messages].reverse();
  const lastOut = rev.find((m) => m.direction === "outbound");
  const lastIn = rev.find((m) => m.direction === "inbound");
  const replied = !!lastIn;
  const waiting = !!lastOut && (!lastIn || +new Date(lastIn.occurred_at) < +new Date(lastOut.occurred_at));
  const waitingDays = waiting && lastOut ? Math.floor((Date.now() - +new Date(lastOut.occurred_at)) / 86400000) : null;
  return { opens, clicks, opened: opens > 0, clicked: clicks > 0, waiting, waitingDays, replied };
}

// Status of the conversation based on its LAST message only (not "any message was
// opened"). If they sent last -> Replied; if I sent last and they opened THAT message
// -> Seen; if I sent last and it isn't opened yet -> Sent.
type LastStatus = "Replied" | "Seen" | "Sent" | "Sending" | "Failed";
function lastMessageStatus(t: Thread, tracks: Record<string, Track>): LastStatus {
  // An email we just handed to the worker outranks everything: until SMTP actually
  // accepts it, calling it "Sent" is a lie.
  if (t.latest.pending === "sending") return "Sending";
  if (t.latest.pending === "failed") return "Failed";
  if (t.latest.direction === "inbound") return "Replied";
  const qid = t.latest.queue_item_id;
  return qid && (tracks[qid]?.opens || 0) > 0 ? "Seen" : "Sent";
}

// A send in flight: the queue row exists and the worker has been kicked, but SMTP
// hasn't confirmed yet. We show it in the thread immediately rather than making you
// stare at nothing for a few seconds wondering whether the click registered.
interface PendingSend {
  qid: string;
  threadKey: string;
  to: string;
  fromAddress: string | null;
  subject: string;
  html: string;
  at: string;
  failed?: string; // error message once the worker gives up
}

const PENDING_POLL_MS = 1500;
// The worker sends in seconds. If a queue row is still pending well past that, the
// worker is wedged or undeployed, and silently spinning forever would be a lie too.
const PENDING_TIMEOUT_MS = 90_000;

// The "charging" bar under a message that is still in flight: a filled sliver
// sweeping left to right, on a loop, until SMTP confirms. Deliberately indeterminate —
// we do not know how long the worker will take, so a fake percentage would be a lie.
// Keyframes are injected here rather than in tailwind.config so this stays self-contained.
const SENDING_CSS = `
@keyframes mb-charge {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
@keyframes mb-breathe {
  0%, 100% { opacity: 0.55; }
  50%      { opacity: 1; }
}
.mb-charge-track { position: relative; overflow: hidden; }
.mb-charge-track::after {
  content: ""; position: absolute; inset: 0;
  width: 25%;
  border-radius: 9999px;
  background: hsl(var(--primary));
  animation: mb-charge 1.1s ease-in-out infinite;
}
.mb-breathe { animation: mb-breathe 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .mb-charge-track::after { animation: none; width: 100%; opacity: 0.4; }
  .mb-breathe { animation: none; }
}
`;

function SendingBar({ error, onDismiss }: { error?: string; onDismiss: () => void }) {
  if (error) {
    return (
      <div className="px-3.5 pb-2.5 pt-1">
        <div className="flex items-start gap-2 text-[11px] text-destructive">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span className="flex-1">Not sent. {error}</span>
          <button onClick={onDismiss} className="underline hover:no-underline shrink-0">dismiss</button>
        </div>
      </div>
    );
  }
  return (
    <div className="px-3.5 pb-2.5 pt-1">
      <p className="text-[11px] text-primary font-medium mb-1.5 mb-breathe inline-flex items-center gap-1.5">
        <Send className="w-3 h-3" /> Sending…
      </p>
      <div className="mb-charge-track h-1 rounded-full bg-primary/15" />
    </div>
  );
}

// Render HTML mail in a sandboxed iframe (its CSS renders correctly and is isolated
// from the app). The email measures ITSELF inside the frame and reports its height out
// via postMessage, so the iframe grows to full content height reliably (measuring from
// the parent was flaky and left frames stuck tall/empty). The frame's own scrollbar is
// off, so each email shows in full and the whole conversation scrolls as one.
function Body({ m }: { m: MailMessage }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const safe = m.body_html && m.body_html.includes("<") ? sanitizeForIframe(m.body_html) : null;

  useEffect(() => {
    if (safe == null) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { __mbid?: string; __mbh?: number };
      if (d && d.__mbid === m.id && typeof d.__mbh === "number" && d.__mbh > 0) {
        const f = ref.current;
        if (f) f.style.height = d.__mbh + 6 + "px";
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [safe, m.id]);

  if (safe == null) {
    return <p className="px-4 py-3 text-sm whitespace-pre-wrap text-foreground leading-relaxed">{cleanBody(m.body_text) || cleanBody(m.snippet) || "(no content)"}</p>;
  }
  const reporter = `<scr` + `ipt>(function(){function R(){try{parent.postMessage({__mbid:${JSON.stringify(m.id)},__mbh:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)},'*')}catch(e){}}window.addEventListener('load',R);if(window.ResizeObserver){try{new ResizeObserver(R).observe(document.body)}catch(e){}}setTimeout(R,50);setTimeout(R,400);setTimeout(R,1200);R();})();</scr` + `ipt>`;
  return (
    <iframe
      ref={ref} title="email" sandbox="allow-scripts allow-popups" scrolling="no"
      className="w-full block bg-white" style={{ width: "100%", display: "block", height: 60, border: 0 }}
      srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:14px;font-family:Arial,sans-serif;font-size:14px;color:#111;line-height:1.5;} img{max-width:100%;height:auto;}</style></head><body>${safe}${reporter}</body></html>`}
    />
  );
}

function MsgTrack({ tr }: { tr?: Track }) {
  const opens = tr?.opens || 0, clicks = tr?.clicks || 0;
  if (!opens && !clicks) return null;
  return (
    <div className="px-1 pt-2 text-[11px] text-muted-foreground flex items-center gap-3">
      {opens > 0 && <span className="inline-flex items-center gap-1"><Eye className="w-3 h-3" />Opened {opens}×{tr?.lastOpen ? ` · ${timeAgo(tr.lastOpen)}` : ""}</span>}
      {clicks > 0 && <span className="inline-flex items-center gap-1"><MousePointerClick className="w-3 h-3" />Clicked {clicks}×</span>}
    </div>
  );
}

function TagChips({ ids, tags, onRemove }: { ids: string[]; tags: Tag[]; onRemove?: (id: string) => void }) {
  const shown = ids.map((id) => tags.find((x) => x.id === id)).filter(Boolean) as Tag[];
  if (!shown.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((t) => (
        <span key={t.id} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ backgroundColor: t.color + "22", color: t.color }}>
          {t.label}
          {onRemove && <button onClick={(e) => { e.stopPropagation(); onRemove(t.id); }} className="hover:opacity-70"><X className="w-2.5 h-2.5" /></button>}
        </span>
      ))}
    </div>
  );
}

export default function MailboxPage() {
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [tracks, setTracks] = useState<Record<string, Track>>({});
  const [tags, setTags] = useState<Tag[]>([]);
  const [contactTags, setContactTags] = useState<Record<string, string[]>>({});
  const [emailToContact, setEmailToContact] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreOutbound, setHasMoreOutbound] = useState(true);
  const outboundCursor = useRef<string | null>(null);
  const firstLoadDone = useRef(false);
  const completedKeys = useRef<Set<string>>(new Set());
  // Inbox first: the mailbox is about the replies you got, not the hundreds we send a
  // day. Sent is loaded lazily only if you go to it.
  const [folder, setFolder] = useState<"all" | "inbox" | "sent" | "archived">("inbox");
  const outboundLoaded = useRef(false);
  const [pending, setPending] = useState<PendingSend[]>([]);
  const [scope, setScope] = useState<string>(loadScope);
  const [scopeSenders, setScopeSenders] = useState<SenderLite[]>([]);
  const [scopeGroups, setScopeGroups] = useState<GroupLite[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | "waiting" | "replied" | "opened" | "clicked" | "noopen">("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // Hide warmup traffic (the "Phone_N0:" signature). On by default while warming, and
  // persisted so it survives a refresh like the inbox scope does.
  const [hideWarmup, setHideWarmup] = useState<boolean>(() => {
    try { return localStorage.getItem(HIDE_WARMUP_KEY) !== "false"; } catch { return true; }
  });
  const [sort, setSort] = useState<"recent" | "waiting" | "opens">("recent");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // The conversation pane pins to the newest message, like any chat. `stick` stays on
  // until you scroll up to read something, and comes back when you return to the
  // bottom — otherwise settling iframes would yank the view out from under you.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const [replyToMsgId, setReplyToMsgId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [cTo, setCTo] = useState("");
  const [cSubject, setCSubject] = useState("");
  const [cBody, setCBody] = useState("");
  const [cSending, setCSending] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const [newTagLabel, setNewTagLabel] = useState("");
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[5]);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [hoverThread, setHoverThread] = useState<{ t: Thread; top: number; left: number } | null>(null);
  const [profileFor, setProfileFor] = useState<{ contactId: string | null; email: string; name: string } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const hoverCloseTimer = useRef<number | null>(null);
  useEffect(() => () => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current); }, []);

  // Merge (not replace) so the 15s refresh, "load more", and an opened thread's full
  // fetch never wipe each other's rows. Server row wins for anything already present.
  const mergeMessages = useCallback((rows: MailMessage[]) => {
    if (!rows.length) return;
    setMessages((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of rows) byId.set(m.id, m);
      return [...byId.values()];
    });
  }, []);

  const load = useCallback(async () => {
    if (!firstLoadDone.current) setLoading(true);
    // Inbound-first: fetch the replies (the mail that matters), NOT the hundreds we send
    // a day. Our own messages inside a replied thread are filled by the completion pass
    // below, and opening any thread loads it in full. The bulk "Sent" list is loaded
    // lazily, only if you actually visit the Sent or All folder.
    // Keep warmup OUT of the load window so real replies are never crowded out as warmup
    // piles up (89% of inbound is warmup). Vendor mail (trulyinbox) and the "Phone_N0:"
    // peers are dropped server-side; the .or() is null-safe so a real reply with an empty
    // body_text is never wrongly excluded, and the client's isWarmupPeer/isVendorSpam
    // still catch any that slip through (e.g. Phone_N0 only in the HTML part).
    const inb = await supabase.from("mailbox_messages" as any)
      .select("*").eq("direction", "inbound")
      .not("from_email", "ilike", "%trulyinbox%")
      .or("body_text.is.null,body_text.not.ilike.%Phone_N0%")
      .order("occurred_at", { ascending: false }).limit(5000);
    const inbRows = (inb.data as unknown as MailMessage[]) || [];
    mergeMessages(inbRows);
    firstLoadDone.current = true;
    setLoading(false);

    // Complete each replied conversation ONCE. A thread with a reply may also have a
    // later send of mine that's older than the outbound page, so without this the list
    // shows "Replied" until you open it. Replied threads are few (low reply rate), and
    // we only fetch keys we haven't completed yet, so this stays cheap.
    const newKeys = [...new Set(inbRows.map((m) => m.thread_key).filter(Boolean) as string[])]
      .filter((k) => !completedKeys.current.has(k));
    for (let i = 0; i < newKeys.length; i += 60) {
      const chunk = newKeys.slice(i, i + 60);
      const { data } = await supabase.from("mailbox_messages" as any)
        .select("*").in("thread_key", chunk).order("occurred_at", { ascending: false }).limit(2000);
      mergeMessages((data as unknown as MailMessage[]) || []);
      chunk.forEach((k) => completedKeys.current.add(k));
    }
  }, [mergeMessages]);

  // Lazily pull the first page of our SENT mail — only when the Sent or All folder is
  // actually opened, so the default Inbox view never pays for it.
  const ensureOutbound = useCallback(async () => {
    if (outboundLoaded.current || loadingMore) return;
    outboundLoaded.current = true;
    setLoadingMore(true);
    const { data } = await supabase.from("mailbox_messages" as any)
      .select("*").eq("direction", "outbound").order("occurred_at", { ascending: false }).limit(OUTBOUND_PAGE);
    const rows = (data as unknown as MailMessage[]) || [];
    mergeMessages(rows);
    outboundCursor.current = rows.length ? rows[rows.length - 1].occurred_at : null;
    setHasMoreOutbound(rows.length === OUTBOUND_PAGE);
    setLoadingMore(false);
  }, [loadingMore, mergeMessages]);

  // Infinite scroll: pull the next older page of outbound. No-op until Sent/All has
  // triggered the first page (outboundCursor stays null in the Inbox view).
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreOutbound || !outboundCursor.current) return;
    setLoadingMore(true);
    const { data } = await supabase.from("mailbox_messages" as any)
      .select("*").eq("direction", "outbound").lt("occurred_at", outboundCursor.current)
      .order("occurred_at", { ascending: false }).limit(OUTBOUND_PAGE);
    const rows = (data as unknown as MailMessage[]) || [];
    mergeMessages(rows);
    if (rows.length) outboundCursor.current = rows[rows.length - 1].occurred_at;
    setHasMoreOutbound(rows.length === OUTBOUND_PAGE);
    setLoadingMore(false);
  }, [loadingMore, hasMoreOutbound, mergeMessages]);

  // Every mailbox's From name, keyed by address, so the composer can resolve sender_*
  // tags in its preview to the actual sending persona.
  const [senderByAddr, setSenderByAddr] = useState<Record<string, { name?: string; email?: string }>>({});
  // The mailboxes you can look at: IMAP on, so replies actually land somewhere.
  useEffect(() => {
    (async () => {
      const { senders, groups } = await fetchSenderTargets();
      setScopeSenders(senders.filter((x) => x.imap_enabled));
      setScopeGroups(groups);
      const map: Record<string, { name?: string; email?: string }> = {};
      for (const s of senders) map[s.from_email.toLowerCase()] = { name: s.from_name || undefined, email: s.from_email };
      setSenderByAddr(map);
    })();
  }, []);

  const scopeAddresses = useMemo(() => {
    if (scope === "all") return null;
    if (scope.startsWith("group:")) {
      const gid = scope.slice(6);
      const addrs = scopeSenders.filter((x) => x.group_id === gid).map((x) => x.from_email.toLowerCase());
      return new Set(addrs);
    }
    const s0 = scopeSenders.find((x) => x.id === scope.slice(7));
    return new Set(s0 ? [s0.from_email.toLowerCase()] : []);
  }, [scope, scopeSenders]);

  const scopeLabel = useMemo(() => {
    if (scope === "all") return "All inboxes";
    if (scope.startsWith("group:")) {
      const g = scopeGroups.find((x) => x.id === scope.slice(6));
      return g ? g.name : "All inboxes";
    }
    const s0 = scopeSenders.find((x) => x.id === scope.slice(7));
    return s0 ? s0.from_email : "All inboxes";
  }, [scope, scopeGroups, scopeSenders]);

  // Watch each in-flight send until the worker resolves it. "sent" means SMTP took
  // it: reload so the thread picks up the worker's real mirrored copy (with its
  // Message-ID, so later replies thread onto it) and the optimistic row falls away.
  useEffect(() => {
    const live = pending.filter((p) => !p.failed);
    if (live.length === 0) return;
    let stop = false;
    const id = setInterval(async () => {
      const qids = live.map((p) => p.qid);
      const { data } = await supabase.from("email_queue").select("id,status,error_message").in("id", qids);
      if (stop) return;
      const byId = new Map(((data as { id: string; status: string; error_message: string | null }[]) || []).map((r) => [r.id, r]));
      let anySent = false;
      setPending((prev) => prev.flatMap((p) => {
        const row = byId.get(p.qid);
        if (!row) return [p];
        if (row.status === "sent") { anySent = true; return []; }
        if (row.status === "failed") return [{ ...p, failed: row.error_message || "The mail server rejected it." }];
        if (row.status === "suppressed") return [{ ...p, failed: "Blocked: this address is on the suppression list." }];
        if (Date.now() - new Date(p.at).getTime() > PENDING_TIMEOUT_MS) {
          return [{ ...p, failed: "Still queued after 90s. The send worker may be down." }];
        }
        return [p];
      }));
      if (anySent) void load();
    }, PENDING_POLL_MS);
    return () => { stop = true; clearInterval(id); };
  }, [pending, load]);

  const dismissPending = (qid: string) => setPending((prev) => prev.filter((p) => p.qid !== qid));

  const loadTags = useCallback(async () => {
    const { data } = await supabase.from("outreach_tags" as any).select("id,label,color").order("created_at");
    setTags((data as unknown as Tag[]) || []);
  }, []);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      const { data, error } = await invokeFn("fetch-imap-replies");
      if (error) throw error;
      toast.success((data as any)?.message || "Synced");
      await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Sync failed"); }
    finally { setSyncing(false); }
  }, [load]);

  useEffect(() => { load(); loadTags(); }, [load, loadTags]);
  useEffect(() => { const id = setInterval(() => { void load(); }, 15000); return () => clearInterval(id); }, [load]);

  useEffect(() => {
    const qids = [...new Set(messages.filter((m) => m.direction === "outbound" && m.queue_item_id).map((m) => m.queue_item_id!))];
    if (!qids.length) { setTracks({}); return; }
    let cancelled = false;
    (async () => {
      const map: Record<string, Track> = {};
      for (let i = 0; i < qids.length; i += 300) {
        const { data } = await supabase.from("email_events" as any).select("queue_item_id,event_type,user_agent,created_at").in("queue_item_id", qids.slice(i, i + 300));
        for (const e of (data as any[]) || []) {
          const t = map[e.queue_item_id] || (map[e.queue_item_id] = { opens: 0, lastOpen: null, clicks: 0, lastClick: null });
          if (e.event_type === "open") { t.opens++; if (!t.lastOpen || e.created_at > t.lastOpen) t.lastOpen = e.created_at; }
          else if (e.event_type === "click" && !isBot(e.user_agent)) { t.clicks++; if (!t.lastClick || e.created_at > t.lastClick) t.lastClick = e.created_at; }
        }
      }
      if (!cancelled) setTracks(map);
    })();
    return () => { cancelled = true; };
  }, [messages]);

  useEffect(() => {
    const emails = [...new Set(messages.map((m) => (m.direction === "inbound" ? m.from_email : m.to_email)?.toLowerCase()).filter(Boolean) as string[])];
    if (!emails.length) return;
    let cancelled = false;
    (async () => {
      const e2c: Record<string, string> = {};
      const cids = new Set<string>();
      for (let i = 0; i < emails.length; i += 300) {
        const { data } = await supabase.from("outreach_contacts").select("id,email").in("email", emails.slice(i, i + 300));
        for (const r of (data as any[]) || []) { e2c[(r.email || "").toLowerCase()] = r.id; cids.add(r.id); }
      }
      const ct: Record<string, string[]> = {};
      const cidArr = [...cids];
      for (let i = 0; i < cidArr.length; i += 300) {
        const { data } = await supabase.from("contact_tags" as any).select("contact_id,tag_id").in("contact_id", cidArr.slice(i, i + 300));
        for (const r of (data as any[]) || []) (ct[r.contact_id] || (ct[r.contact_id] = [])).push(r.tag_id);
      }
      if (!cancelled) { setEmailToContact(e2c); setContactTags(ct); }
    })();
    return () => { cancelled = true; };
  }, [messages]);

  // Synthesise a message row per in-flight send, keyed to the thread it belongs to,
  // and drop it the moment the worker's real mirrored copy shows up (same queue id).
  const withPending = useMemo<MailMessage[]>(() => {
    if (pending.length === 0) return messages;
    const landed = new Set(messages.map((m) => m.queue_item_id).filter(Boolean) as string[]);
    const rows: MailMessage[] = pending
      .filter((p) => !landed.has(p.qid))
      .map((p) => ({
        id: `pending:${p.qid}`,
        direction: "outbound" as const,
        thread_key: p.threadKey,
        message_id: null,
        queue_item_id: p.qid,
        contact_id: null,
        from_email: p.fromAddress,
        from_name: null,
        to_email: p.to,
        subject: p.subject,
        body_html: p.html,
        body_text: null,
        snippet: null,
        occurred_at: p.at,
        seen: true,
        archived_at: null,
        pending: p.failed ? ("failed" as const) : ("sending" as const),
        pendingError: p.failed,
      }));
    return rows.length > 0 ? [...messages, ...rows] : messages;
  }, [messages, pending]);

  const threads = useMemo<Thread[]>(() => {
    const map = new Map<string, MailMessage[]>();
    for (const m of withPending) { const k = m.thread_key || m.id; (map.get(k) || map.set(k, []).get(k)!).push(m); }
    const out: Thread[] = [];
    for (const [key, msgs] of map) {
      const sorted = [...msgs].sort((a, b) => +new Date(a.occurred_at) - +new Date(b.occurred_at));
      const inb = sorted.find((m) => m.direction === "inbound");
      const outb = sorted.find((m) => m.direction === "outbound");
      const counterparty = (inb?.from_email || outb?.to_email || "").trim();
      const latest = sorted[sorted.length - 1];
      out.push({
        key, messages: sorted, latest, counterparty,
        counterpartyName: sorted.find((m) => m.direction === "inbound" && m.from_name)?.from_name || counterparty,
        subject: sorted[0].subject || "(no subject)",
        unread: sorted.filter((m) => m.direction === "inbound" && !m.seen).length,
        hasInbound: !!inb, hasOutbound: !!outb,
        // Archived only when EVERY message is archived. Any new message (a reply or
        // a follow-up we send) arrives with archived_at null, so the thread has an
        // un-archived message and resurfaces in the inbox — robust to how the reply's
        // occurred_at compares to the archive time (out-of-order sync is fine).
        archived: sorted.every((m) => !!m.archived_at),
        // Our address for this conversation: From on a send, else the inbox a reply
        // came back to.
        ourAddress: outb?.from_email || inb?.to_email || null,
        warmup: sorted.some(isWarmupPeer),
        vendorSpam: sorted.some(isVendorSpam),
      });
    }
    out.sort((a, b) => +new Date(b.latest.occurred_at) - +new Date(a.latest.occurred_at));
    return out;
  }, [withPending]);

  const contactIdFor = useCallback((t: Thread): string | null =>
    emailToContact[t.counterparty.toLowerCase()] || t.messages.find((m) => m.contact_id)?.contact_id || null, [emailToContact]);
  const tagIdsFor = useCallback((t: Thread): string[] => { const cid = contactIdFor(t); return cid ? contactTags[cid] || [] : []; }, [contactIdFor, contactTags]);

  const insights = useMemo(() => { const m = new Map<string, Insight>(); for (const t of threads) m.set(t.key, threadInsight(t, tracks)); return m; }, [threads, tracks]);
  const counts = useMemo(() => {
    let waiting = 0, opened = 0, replied = 0, clicked = 0;
    for (const t of threads) { if (t.archived) continue; const i = insights.get(t.key); if (!i) continue; if (i.waiting) waiting++; if (i.opened) opened++; if (i.replied) replied++; if (i.clicked) clicked++; }
    return { waiting, opened, replied, clicked };
  }, [threads, insights]);
  const inScope = useCallback(
    (t: Thread) => !scopeAddresses || !!(t.ourAddress && scopeAddresses.has(t.ourAddress.toLowerCase())),
    [scopeAddresses],
  );
  const archivedCount = useMemo(() => threads.reduce((n, t) => n + (t.archived && inScope(t) ? 1 : 0), 0), [threads, inScope]);

  const visible = useMemo(() => {
    let arr = threads.filter((t) => {
      // Scope: only conversations on the mailbox(es) currently being viewed.
      if (scopeAddresses && !(t.ourAddress && scopeAddresses.has(t.ourAddress.toLowerCase()))) return false;
      // Vendor spam (trulyinbox) is never a prospect — always hidden.
      if (t.vendorSpam) return false;
      // Warmup peers are hidden while warming, unless explicitly shown.
      if (hideWarmup && t.warmup) return false;
      // Archived conversations live only in the Archived section; every other
      // folder hides them.
      if (folder === "archived") { if (!t.archived) return false; }
      else {
        if (t.archived) return false;
        if (folder === "inbox" && !t.hasInbound) return false;
        if (folder === "sent" && !t.hasOutbound) return false;
      }
      if (search) { const q = search.toLowerCase(); if (!t.counterparty.toLowerCase().includes(q) && !t.subject.toLowerCase().includes(q)) return false; }
      if (tagFilter && !tagIdsFor(t).includes(tagFilter)) return false;
      const i = insights.get(t.key);
      if (statusFilter !== "all" && i) {
        if (statusFilter === "waiting" && !i.waiting) return false;
        if (statusFilter === "replied" && !i.replied) return false;
        if (statusFilter === "opened" && !i.opened) return false;
        if (statusFilter === "clicked" && !i.clicked) return false;
        if (statusFilter === "noopen" && (!t.hasOutbound || i.opened)) return false;
      }
      return true;
    });
    if (sort === "waiting") arr = [...arr].sort((a, b) => (insights.get(b.key)?.waitingDays ?? -1) - (insights.get(a.key)?.waitingDays ?? -1));
    else if (sort === "opens") arr = [...arr].sort((a, b) => (insights.get(b.key)?.opens ?? 0) - (insights.get(a.key)?.opens ?? 0));
    return arr;
  }, [threads, folder, search, statusFilter, tagFilter, sort, insights, tagIdsFor, scopeAddresses, hideWarmup]);

  // How many warmup threads are being hidden right now (in the current scope/folder),
  // so the toggle can show a count instead of hiding traffic silently.
  const warmupHidden = useMemo(() => {
    if (!hideWarmup) return 0;
    return threads.reduce((n, t) => {
      if (t.vendorSpam || !t.warmup || t.archived) return n; // vendor spam isn't counted; it's just gone
      if (scopeAddresses && !(t.ourAddress && scopeAddresses.has(t.ourAddress.toLowerCase()))) return n;
      return n + 1;
    }, 0);
  }, [threads, hideWarmup, scopeAddresses]);

  const grouped = useMemo(() => {
    if (sort !== "recent") return visible.length ? [{ bucket: sort === "waiting" ? "Longest waiting" : "Most opened", threads: visible }] : [];
    const out: { bucket: string; threads: Thread[] }[] = [];
    for (const t of visible) { const b = dateBucket(t.latest.occurred_at); const last = out[out.length - 1]; if (last && last.bucket === b) last.threads.push(t); else out.push({ bucket: b, threads: [t] }); }
    return out;
  }, [visible, sort]);

  // Number shown on the Inbox tab. It counts the CONVERSATIONS you'd actually see in
  // the inbox (in scope, not archived, has a real inbound message, warmup excluded when
  // hidden) so the badge equals the list length instead of an unread-message sum that
  // never matched what's on screen.
  const inboxUnread = useMemo(
    () => threads.reduce((n, t) => {
      if (t.archived || !t.hasInbound || !inScope(t) || t.vendorSpam) return n;
      if (hideWarmup && t.warmup) return n;
      return n + 1;
    }, 0),
    [threads, inScope, hideWarmup],
  );
  // Inbox-worthy reply threads per receiving mailbox, so the scope dropdown can show a
  // count and we can nudge when replies are sitting in an inbox that's out of scope.
  const repliesByAddr = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of threads) {
      if (t.archived || !t.hasInbound || t.vendorSpam) continue;
      if (hideWarmup && t.warmup) continue;
      const a = (t.ourAddress || "").toLowerCase();
      if (a) m.set(a, (m.get(a) || 0) + 1);
    }
    return m;
  }, [threads, hideWarmup]);
  // With a specific scope selected, how many reply threads live in your OTHER inboxes
  // (the exact thing that made post-rotation replies "disappear").
  const otherInboxReplies = useMemo(() => {
    if (!scopeAddresses) return 0;
    let n = 0;
    for (const [addr, c] of repliesByAddr) if (!scopeAddresses.has(addr)) n += c;
    return n;
  }, [repliesByAddr, scopeAddresses]);
  const selected = threads.find((t) => t.key === selectedKey) || null;
  const selectedContactId = selected ? contactIdFor(selected) : null;
  const selectedTagIds = selected ? tagIdsFor(selected) : [];
  const filtersActive = statusFilter !== "all" || !!tagFilter || sort !== "recent";

  // Everything except the newest message opens collapsed: a long thread is history you
  // already know, and the thing you came to read is the last message.
  const collapseAllButLast = (msgs: MailMessage[]) =>
    setCollapsed(new Set(msgs.slice(0, -1).map((m) => m.id)));

  const openThread = useCallback(async (t: Thread) => {
    setSelectedKey(t.key); setReplyToMsgId(null); setReplyDraft(""); setTagPanelOpen(false);
    collapseAllButLast(t.messages);
    stick.current = true;
    // Fetch the WHOLE thread by its thread_key so the open conversation is never
    // partial, regardless of the list window. (thread_key is null only for singletons,
    // whose one message is already loaded.)
    const tk = t.messages[0]?.thread_key;
    let full = t.messages;
    if (tk) {
      const { data } = await supabase.from("mailbox_messages" as any)
        .select("*").eq("thread_key", tk).order("occurred_at", { ascending: true });
      const rows = (data as unknown as MailMessage[]) || [];
      // Re-collapse against the FULL thread: the list only had a window of it, so the
      // last message we knew about a moment ago may not be the real last one.
      if (rows.length) { full = rows; mergeMessages(rows); collapseAllButLast(rows); }
    }
    const unseen = full.filter((m) => m.direction === "inbound" && !m.seen).map((m) => m.id);
    if (unseen.length) {
      await supabase.from("mailbox_messages" as any).update({ seen: true }).in("id", unseen);
      setMessages((prev) => prev.map((m) => unseen.includes(m.id) ? { ...m, seen: true } : m));
    }
  }, [mergeMessages]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Messages render in iframes that report their height back asynchronously, so the
  // pane keeps growing for a beat after it first paints. Watch the content box and
  // re-pin on every growth instead of scrolling once and landing short.
  useEffect(() => {
    const box = contentRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => { if (stick.current) scrollToBottom(); });
    ro.observe(box);
    return () => ro.disconnect();
  }, [selectedKey, scrollToBottom]);

  // Jump to the newest message when a thread opens, and again when one is added.
  useEffect(() => {
    if (!selectedKey) return;
    stick.current = true;
    requestAnimationFrame(scrollToBottom);
  }, [selectedKey, selected?.messages.length, scrollToBottom]);

  // Reading back through history unpins; returning to the bottom re-pins.
  const onThreadScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const onRowEnter = (t: Thread, el: HTMLElement) => {
    if (hoverCloseTimer.current) { window.clearTimeout(hoverCloseTimer.current); hoverCloseTimer.current = null; }
    const rect = el.getBoundingClientRect();
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHoverThread({ t, top: rect.top, left: rect.right + 8 }), 450);
  };
  // Close on a short delay so the pointer can travel onto the card and use its buttons.
  const onRowLeave = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = window.setTimeout(() => setHoverThread(null), 220);
  };
  const keepHoverOpen = () => { if (hoverCloseTimer.current) { window.clearTimeout(hoverCloseTimer.current); hoverCloseTimer.current = null; } };
  const closeHoverNow = () => { if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current); setHoverThread(null); };
  const openProfile = (t: Thread) => { setProfileFor({ contactId: contactIdFor(t), email: t.counterparty, name: t.counterpartyName || t.counterparty }); closeHoverNow(); };

  const toggleCollapse = (id: string) => setCollapsed((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Archive (or restore) a whole conversation. Stamp every message so the thread's
  // latest reflects the new state; a later inbound reply naturally un-archives it.
  const archiveThread = async (t: Thread, archive: boolean) => {
    const ids = t.messages.map((m) => m.id);
    const val = archive ? new Date().toISOString() : null;
    setMessages((prev) => prev.map((m) => ids.includes(m.id) ? { ...m, archived_at: val } : m));
    if (selectedKey === t.key) setSelectedKey(null);
    const { error } = await supabase.from("mailbox_messages" as any).update({ archived_at: val }).in("id", ids);
    if (error) { toast.error(error.message); void load(); }
    else toast.success(archive ? "Archived" : "Restored to inbox");
  };

  const toggleTag = async (contactId: string, tagId: string) => {
    const has = (contactTags[contactId] || []).includes(tagId);
    setContactTags((prev) => { const cur = prev[contactId] || []; return { ...prev, [contactId]: has ? cur.filter((x) => x !== tagId) : [...cur, tagId] }; });
    if (has) await supabase.from("contact_tags" as any).delete().eq("contact_id", contactId).eq("tag_id", tagId);
    else { const { error } = await supabase.from("contact_tags" as any).insert({ contact_id: contactId, tag_id: tagId }); if (error && !/duplicate/i.test(error.message)) toast.error(error.message); }
  };

  const createTag = async () => {
    const label = newTagLabel.trim();
    if (!label) return;
    const { data, error } = await supabase.from("outreach_tags" as any).insert({ label, color: newTagColor }).select("id,label,color").single();
    if (error) { toast.error(error.message); return; }
    setTags((prev) => [...prev, data as unknown as Tag]);
    setNewTagLabel("");
    if (selectedContactId) await toggleTag(selectedContactId, (data as any).id);
  };

  // html comes fully-composed (styled) from RichComposer.
  const sendReplyHtml = async (html: string, sopts?: { plainText?: boolean; trackingImageUrl?: string | null; templateId?: string | null }) => {
    if (!selected) return;
    setSending(true);
    try {
      const subject = /^re:/i.test(selected.subject) ? selected.subject : `Re: ${selected.subject}`;
      // Thread it as a real reply: In-Reply-To = the message being answered,
      // References = the whole thread's Message-ID chain.
      const replyMsg = selected.messages.find((m) => m.id === replyToMsgId) || selected.messages[selected.messages.length - 1];
      const inReplyTo = replyMsg?.message_id || null;
      const references = selected.messages.map((m) => m.message_id).filter(Boolean).join(" ") || null;
      // Reply from the exact address this conversation is on.
      const qid = await queueAndSend(selected.counterparty, subject, html, { inReplyTo, references, fromAddress: selected.ourAddress || undefined, plainText: sopts?.plainText, trackingImageUrl: sopts?.trackingImageUrl, templateId: sopts?.templateId });
      setPending((prev) => [...prev, {
        qid, threadKey: selected.key, to: selected.counterparty,
        fromAddress: selected.ourAddress, subject, html, at: new Date().toISOString(),
      }]);
      setReplyToMsgId(null);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Send failed"); }
    finally { setSending(false); }
  };
  const sendComposeHtml = async (html: string, sopts?: { plainText?: boolean; trackingImageUrl?: string | null; templateId?: string | null }) => {
    if (!cTo.trim()) { toast.error("A recipient (To) is required"); return; }
    setCSending(true);
    try {
      const to = cTo.trim();
      const subject = cSubject.trim() || "(no subject)";
      const qid = await queueAndSend(to, subject, html, { plainText: sopts?.plainText, trackingImageUrl: sopts?.trackingImageUrl, templateId: sopts?.templateId });
      // No thread exists yet for a brand-new conversation, so the optimistic row keys
      // itself to the queue id and becomes its own thread until the real one lands.
      setPending((prev) => [...prev, {
        qid, threadKey: `pending:${qid}`, to, fromAddress: null, subject, html, at: new Date().toISOString(),
      }]);
      setComposeOpen(false); setCTo(""); setCSubject("");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Send failed"); } finally { setCSending(false); }
  };

  const FILTERS: { id: typeof statusFilter; label: string }[] = [
    { id: "all", label: "All" }, { id: "waiting", label: `Waiting ${counts.waiting}` }, { id: "replied", label: `Replied ${counts.replied}` },
    { id: "opened", label: `Opened ${counts.opened}` }, { id: "clicked", label: `Clicked ${counts.clicked}` }, { id: "noopen", label: "No opens" },
  ];

  return (
    <div className="flex gap-0 flex-1 min-h-0 overflow-hidden">
      <style>{SENDING_CSS}</style>
      {/* Thread list */}
      <div className="w-96 flex-shrink-0 border-r border-border flex flex-col">
        <div className="p-2.5 border-b border-border space-y-2">
          {/* Whose inbox am I looking at. Sticks across refreshes. */}
          <div className="flex items-center gap-1.5">
            <Inbox className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <select
              value={scope}
              onChange={(e) => { const v = e.target.value; setScope(v); saveScope(v); setSelectedKey(null); }}
              title="Which mailbox this view is showing"
              className="flex-1 min-w-0 h-7 text-xs bg-transparent border border-border rounded-lg px-2 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All inboxes{scopeSenders.length ? ` (${scopeSenders.length})` : ""}</option>
              {scopeGroups.length > 0 && (
                <optgroup label="Groups">
                  {scopeGroups.map((g) => {
                    const n = scopeSenders.filter((x) => x.group_id === g.id).length;
                    return <option key={g.id} value={`group:${g.id}`} disabled={n === 0}>{g.name} · {n} inbox{n === 1 ? "" : "es"}</option>;
                  })}
                </optgroup>
              )}
              <optgroup label="Single inbox">
                {scopeSenders.map((x) => { const c = repliesByAddr.get(x.from_email.toLowerCase()) || 0; return <option key={x.id} value={`sender:${x.id}`}>{x.from_email}{c ? ` · ${c}` : ""}</option>; })}
              </optgroup>
            </select>
            {scope !== "all" && (
              <button onClick={() => { setScope("all"); saveScope("all"); }} title="Show every inbox again"
                className="h-7 w-7 flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted/50 transition-colors shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {scope !== "all" && otherInboxReplies > 0 && (
            <button onClick={() => { setScope("all"); saveScope("all"); }}
              className="flex items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px] text-foreground hover:bg-primary/10 transition-colors">
              <span><b className="text-primary">{otherInboxReplies}</b> repl{otherInboxReplies === 1 ? "y" : "ies"} in your other inboxes aren't shown here.</span>
              <span className="font-medium text-primary shrink-0">View all →</span>
            </button>
          )}
          <div className="flex items-center gap-2">
            <div className="flex-1 flex bg-muted/40 rounded-lg p-0.5">
              {([["all", "All"], ["inbox", inboxUnread ? `Inbox ${inboxUnread}` : "Inbox"], ["sent", "Sent"], ["archived", archivedCount ? `Archived ${archivedCount}` : "Archived"]] as const).map(([f, label]) => (
                <button key={f} onClick={() => { const nf = f as typeof folder; setFolder(nf); setSelectedKey(null); if (nf === "sent" || nf === "all") void ensureOutbound(); }}
                  className={cn("flex-1 py-1 text-xs rounded-md transition-colors whitespace-nowrap", folder === f ? "bg-background shadow-sm text-foreground font-medium" : "text-muted-foreground hover:text-foreground")}>{label}</button>
              ))}
            </div>
            <button onClick={sync} disabled={syncing} title="Sync inbox" className="h-7 w-7 flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted/50 transition-colors"><RefreshCw className={cn("w-3.5 h-3.5", syncing && "animate-spin")} /></button>
            <button onClick={() => setComposeOpen(true)} title="Compose" className="h-7 w-7 flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"><PenSquare className="w-3.5 h-3.5" /></button>
          </div>
          <div className="flex items-center gap-1.5">
            <input className="flex-1 border border-input rounded-lg px-3 py-1.5 text-xs bg-background focus:outline-none focus:ring-2 focus:ring-ring" placeholder="Search mail…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <button onClick={() => setFiltersOpen((o) => !o)} title="Filters, tags, sort"
              className={cn("relative h-7 w-7 flex items-center justify-center rounded-lg border transition-colors", filtersOpen || filtersActive ? "border-primary text-primary bg-primary/5" : "border-border text-muted-foreground hover:bg-muted/50")}>
              <SlidersHorizontal className="w-3.5 h-3.5" />
              {filtersActive && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary" />}
            </button>
          </div>
          {filtersOpen && (
            <div className="space-y-2 pt-1">
              <div className="flex flex-wrap gap-1">
                {FILTERS.map((f) => (
                  <button key={f.id} onClick={() => setStatusFilter(f.id)}
                    className={cn("text-[10px] px-2 py-0.5 rounded-full border transition-colors", statusFilter === f.id ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground border-border hover:bg-muted/50")}>{f.label}</button>
                ))}
              </div>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {tags.map((t) => (
                    <button key={t.id} onClick={() => setTagFilter(tagFilter === t.id ? null : t.id)}
                      className={cn("inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border transition-colors", tagFilter === t.id ? "border-foreground/40 bg-muted text-foreground" : "border-border text-muted-foreground hover:bg-muted/50")}>
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.color }} />{t.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>Sort</span>
                {(["recent", "waiting", "opens"] as const).map((s) => (
                  <button key={s} onClick={() => setSort(s)} className={cn("px-1.5 py-0.5 rounded", sort === s ? "bg-muted font-semibold text-foreground" : "hover:bg-muted/50")}>{s === "recent" ? "Recent" : s === "waiting" ? "Waiting" : "Opens"}</button>
                ))}
              </div>
              {/* Warmup traffic hide. Detected by the "Phone_N0:" signature. */}
              <button
                onClick={() => setHideWarmup((v) => { const next = !v; try { localStorage.setItem(HIDE_WARMUP_KEY, String(next)); } catch { /* private mode */ } return next; })}
                className="flex items-center justify-between w-full text-[10px] rounded-md border border-border px-2 py-1 hover:bg-muted/50 transition-colors"
                title='Warmup emails are detected by their "Phone_N0:" signature line'
              >
                <span className={cn(hideWarmup ? "text-foreground font-medium" : "text-muted-foreground")}>
                  {hideWarmup ? "Warmup emails hidden" : "Warmup emails shown"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  {hideWarmup && warmupHidden > 0 && <span className="text-muted-foreground/70">{warmupHidden} hidden</span>}
                  <span className={cn("relative w-7 h-4 rounded-full transition-colors", hideWarmup ? "bg-primary" : "bg-muted-foreground/30")}>
                    <span className={cn("absolute top-0.5 w-3 h-3 rounded-full bg-background transition-all", hideWarmup ? "left-3.5" : "left-0.5")} />
                  </span>
                </span>
              </button>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto min-h-0"
          onScroll={(e) => { const el = e.currentTarget; if (hasMoreOutbound && !loadingMore && el.scrollHeight - el.scrollTop - el.clientHeight < 400) void loadMore(); }}>
          {loading && messages.length === 0 && <p className="text-xs text-muted-foreground p-4 text-center">Loading…</p>}
          {!loading && visible.length === 0 && <p className="text-xs text-muted-foreground p-4 text-center">{folder === "archived" ? "Nothing archived" : scope !== "all" ? `No messages in ${scopeLabel}` : "No messages"}</p>}
          {grouped.map((g) => (
            <div key={g.bucket}>
              <div className="sticky top-0 z-10 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 bg-muted/60 backdrop-blur border-b border-border/50">{g.bucket}</div>
              {g.threads.map((t) => {
                const tIds = tagIdsFor(t);
                const firstTag = tIds.length ? tags.find((x) => x.id === tIds[0]) : null;
                const name = t.counterpartyName || t.counterparty || "(unknown)";
                const initial = (name.trim()[0] || "?").toUpperCase();
                // Status from the LAST message: Replied / Seen / Sent.
                const status = lastMessageStatus(t, tracks);
                return (
                  <div key={t.key} className="group/row relative border-b border-border/50">
                    <button onClick={() => openThread(t)}
                      onMouseEnter={(e) => onRowEnter(t, e.currentTarget)} onMouseLeave={onRowLeave}
                      className={cn("relative w-full text-left px-3 py-2.5 hover:bg-muted/30 transition-colors overflow-hidden", selectedKey === t.key && "bg-primary/5")}
                      style={firstTag ? { backgroundImage: `linear-gradient(to left, ${firstTag.color}26, transparent 55%)` } : undefined}>
                      <div className="relative flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-sm font-medium flex-shrink-0">{initial}</div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            {t.unread > 0 && <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />}
                            <span className={cn("text-sm truncate flex-1", t.unread > 0 ? "font-semibold text-foreground" : "font-medium text-foreground")}>{name}</span>
                            <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">{shortTime(t.latest.occurred_at)}</span>
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                            <span className={cn("text-[11px] flex-shrink-0",
                              status === "Sending" ? "text-primary font-medium mb-breathe"
                                : status === "Failed" ? "text-destructive font-medium"
                                : status === "Replied" ? "text-foreground font-medium"
                                : "text-muted-foreground")}>{status}</span>
                            <span className="text-[11px] text-muted-foreground/60 truncate">· {listSnippet(t.latest)}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                    {/* Hover action: archive (or restore) without opening the thread. */}
                    <button onClick={(e) => { e.stopPropagation(); void archiveThread(t, !t.archived); }}
                      title={t.archived ? "Restore to inbox" : "Archive"}
                      className="absolute top-1/2 -translate-y-1/2 right-2 opacity-0 group-hover/row:opacity-100 focus:opacity-100 h-7 w-7 flex items-center justify-center rounded-md bg-background/95 border border-border text-muted-foreground hover:text-foreground hover:bg-muted shadow-sm transition-opacity z-10">
                      {t.archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
          {loadingMore && <p className="text-xs text-muted-foreground p-3 text-center">Loading more…</p>}
          {!loading && !loadingMore && !hasMoreOutbound && visible.length > 0 && (
            <p className="text-[10px] text-muted-foreground/50 p-3 text-center">That's the whole inbox</p>
          )}
        </div>
      </div>

      {/* Reading pane */}
      <div className="flex-1 min-w-0 flex flex-col">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-center p-8"><div><Mail className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" /><p className="text-sm text-muted-foreground font-medium">Select a conversation</p></div></div>
        ) : (
          <>
            <div className="px-5 py-3 border-b border-border flex items-center gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{selected.subject}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {selected.counterpartyName} · {selected.counterparty}
                  {(() => {
                    const i = insights.get(selected.key); if (!i) return null;
                    const bits: string[] = [];
                    if (i.replied) bits.push("replied"); else if (i.waiting && i.waitingDays !== null) bits.push(`waiting ${i.waitingDays}d`);
                    if (i.opened) bits.push(`opened ${i.opens}×`);
                    return bits.length ? ` · ${bits.join(" · ")}` : null;
                  })()}
                </p>
                {selected.ourAddress && (
                  <p className="text-[11px] text-muted-foreground/70 truncate mt-0.5" title="The mailbox this conversation is on; replies go from here">
                    via {selected.ourAddress}
                  </p>
                )}
              </div>
              <div className="ml-auto flex items-center gap-1 flex-shrink-0 text-muted-foreground">
                <button onClick={() => setProfileFor({ contactId: selectedContactId, email: selected.counterparty, name: selected.counterpartyName || selected.counterparty })} title="Profile" className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted/60 hover:text-foreground transition-colors"><User className="w-4 h-4" /></button>
                <button onClick={() => archiveThread(selected, !selected.archived)} title={selected.archived ? "Restore to inbox" : "Archive"} className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted/60 hover:text-foreground transition-colors">{selected.archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}</button>
                <button disabled={!selectedContactId} onClick={() => setTagPanelOpen((o) => !o)} title={selectedContactId ? "Tags" : "Not a saved contact"} className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted/60 hover:text-foreground transition-colors disabled:opacity-40"><TagIcon className="w-4 h-4" /></button>
              </div>
            </div>

            {(tagPanelOpen || selectedTagIds.length > 0) && (
              <div className="px-5 py-2 border-b border-border bg-muted/10 flex flex-col gap-2">
                {selectedTagIds.length > 0 && <TagChips ids={selectedTagIds} tags={tags} onRemove={selectedContactId ? (id) => toggleTag(selectedContactId, id) : undefined} />}
                {tagPanelOpen && selectedContactId && (
                  <>
                    <div className="flex flex-wrap gap-1">
                      {tags.map((t) => {
                        const on = selectedTagIds.includes(t.id);
                        return (
                          <button key={t.id} onClick={() => toggleTag(selectedContactId, t.id)}
                            className={cn("inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-opacity", on ? "opacity-100" : "opacity-50 hover:opacity-100")}
                            style={{ borderColor: t.color, color: t.color, backgroundColor: on ? t.color + "22" : "transparent" }}>
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.color }} />{t.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input value={newTagLabel} onChange={(e) => setNewTagLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createTag(); }}
                        placeholder="New tag…" className="border border-input rounded px-2 py-0.5 text-[11px] bg-background w-28 focus:outline-none focus:ring-1 focus:ring-ring" />
                      <div className="flex gap-0.5">
                        {TAG_COLORS.map((c) => (<button key={c} onClick={() => setNewTagColor(c)} className={cn("w-3.5 h-3.5 rounded-full", newTagColor === c && "ring-2 ring-offset-1 ring-foreground/40")} style={{ backgroundColor: c }} />))}
                      </div>
                      <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px] gap-0.5" onClick={createTag} disabled={!newTagLabel.trim()}><Plus className="w-3 h-3" />Add</Button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Conversation — avatar + a subtle card per email, so each message reads as
                its own block and You vs them is clear at a glance. */}
            <div ref={scrollRef} onScroll={onThreadScroll} className="flex-1 overflow-y-auto min-h-0">
              <div ref={contentRef} className="p-5 space-y-3">
              {selected.messages.map((m) => {
                const open = !collapsed.has(m.id);
                const isOut = m.direction === "outbound";
                const who = isOut ? "You" : (m.from_name || m.from_email || "Them");
                const initial = (isOut ? "Y" : (who.trim()[0] || "?")).toUpperCase();
                const inFlight = m.pending === "sending";
                const didFail = m.pending === "failed";
                return (
                  <div key={m.id} className={cn("flex gap-3", inFlight && "animate-fade-in")}>
                    <div className={cn("w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium flex-shrink-0 mt-0.5",
                      isOut ? "bg-primary text-primary-foreground" : "bg-foreground/15 text-foreground", inFlight && "mb-breathe")}>{initial}</div>
                    <div className={cn("flex-1 min-w-0 rounded-lg border overflow-hidden",
                      didFail ? "bg-destructive/[0.04] border-destructive/30"
                        : isOut ? "bg-primary/[0.06] border-primary/25" : "bg-muted/50 border-border",
                      inFlight && "border-primary/40")}>
                      <div className="px-3.5 py-2 flex items-baseline gap-2 cursor-pointer hover:bg-muted/20 transition-colors" onClick={() => toggleCollapse(m.id)}>
                        <span className="text-sm font-medium text-foreground flex-shrink-0">{who}</span>
                        <span className="text-xs text-muted-foreground/60 truncate">{isOut ? `to ${m.to_email || ""}` : m.from_email}</span>
                        <span className="ml-auto text-xs text-muted-foreground/50 flex-shrink-0">
                          {m.pending ? (didFail ? "not sent" : "just now") : timeAgo(m.occurred_at)}
                        </span>
                      </div>
                      {open ? (
                        <div className="border-t border-border/50">
                          <Body m={m} />
                          {/* An in-flight send shows the charging bar where its tracking
                              row will go; opens/clicks cannot exist until it has landed. */}
                          {m.pending ? (
                            <SendingBar error={m.pendingError} onDismiss={() => m.queue_item_id && dismissPending(m.queue_item_id)} />
                          ) : isOut ? (
                            <div className="px-3.5 pb-2"><MsgTrack tr={m.queue_item_id ? tracks[m.queue_item_id] : undefined} /></div>
                          ) : null}
                        </div>
                      ) : (
                        <p className="px-3.5 pb-2 text-sm text-muted-foreground truncate">{listSnippet(m)}</p>
                      )}
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
            <div className="border-t border-border p-3 flex-shrink-0 max-h-[62vh] overflow-y-auto">
              <RichComposer compact sending={sending} placeholder={`Reply to ${selected.counterparty}…`}
                onSend={sendReplyHtml} contact={{ id: selectedContactId, email: selected.counterparty, name: selected.counterpartyName }}
                sender={selected.ourAddress ? senderByAddr[selected.ourAddress.toLowerCase()] : undefined} />
            </div>
          </>
        )}
      </div>

      {/* Rich hover preview — appears beside a row after a short hover */}
      {hoverThread && (() => {
        const t = hoverThread.t;
        const ins = insights.get(t.key);
        const st = lastMessageStatus(t, tracks);
        const tIds = tagIdsFor(t);
        const name = t.counterpartyName || t.counterparty || "(unknown)";
        return (
          <div className="fixed z-50 w-64 rounded-xl border border-border bg-card shadow-lg p-3"
            onMouseEnter={keepHoverOpen} onMouseLeave={closeHoverNow}
            style={{ top: Math.max(8, Math.min(hoverThread.top, window.innerHeight - 280)), left: hoverThread.left }}>
            <div className="flex items-center gap-2.5 mb-2.5">
              <div className="w-9 h-9 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-sm font-medium flex-shrink-0">{(name.trim()[0] || "?").toUpperCase()}</div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{name}</p>
                <p className="text-xs text-muted-foreground truncate">{t.counterparty}</p>
                {t.ourAddress && <p className="text-[10px] text-muted-foreground/60 truncate">via {t.ourAddress}</p>}
              </div>
            </div>
            {tIds.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2.5">
                {tIds.map((id) => { const tag = tags.find((x) => x.id === id); return tag ? (
                  <span key={id} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full" style={{ backgroundColor: tag.color + "22", color: tag.color }}>
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: tag.color }} />{tag.label}
                  </span>
                ) : null; })}
              </div>
            )}
            <div className="text-xs text-muted-foreground space-y-1 border-t border-border/50 pt-2">
              <div className="flex items-center gap-1.5">
                <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", st === "Replied" ? "bg-emerald-500" : st === "Seen" ? "bg-amber-500" : "bg-muted-foreground/40")} />
                {st === "Replied" ? "They replied, your turn" : st === "Seen" ? "They saw your last message" : "Sent, not opened yet"}
              </div>
              {ins?.waiting && ins.waitingDays !== null && <div>Waiting {ins.waitingDays} day{ins.waitingDays === 1 ? "" : "s"}</div>}
              {ins && (ins.opens > 0 || ins.clicks > 0) && <div>{ins.opens} open{ins.opens === 1 ? "" : "s"}{ins.clicks > 0 ? ` · ${ins.clicks} click${ins.clicks === 1 ? "" : "s"}` : ""}</div>}
              <div>Last activity {timeAgo(t.latest.occurred_at)}</div>
            </div>
            <button onClick={() => openProfile(t)}
              className="mt-2.5 w-full inline-flex items-center justify-center gap-1.5 text-xs font-medium h-8 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
              <User className="w-3.5 h-3.5" /> Profile
            </button>
          </div>
        );
      })()}

      <ContactProfilePanel
        open={!!profileFor}
        onClose={() => setProfileFor(null)}
        contactId={profileFor?.contactId ?? null}
        fallbackEmail={profileFor?.email}
        fallbackName={profileFor?.name}
        onUpdated={() => void load()}
      />


      {/* Compose modal */}
      {composeOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={() => setComposeOpen(false)}>
          <div className="bg-card rounded-2xl shadow-2xl w-full max-w-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <h3 className="font-semibold text-foreground text-sm flex items-center gap-2"><PenSquare className="w-4 h-4" /> New email</h3>
              <button onClick={() => setComposeOpen(false)}><X className="w-4 h-4 text-muted-foreground" /></button>
            </div>
            <div className="p-5 flex flex-col gap-3">
              <input className="w-full border border-input rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring" placeholder="To (email address)" value={cTo} onChange={(e) => setCTo(e.target.value)} />
              <input className="w-full border border-input rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring" placeholder="Subject" value={cSubject} onChange={(e) => setCSubject(e.target.value)} />
              <RichComposer sending={cSending} placeholder="Write your message…" onSend={sendComposeHtml} onSubject={setCSubject} contact={{ email: cTo }} sender={Object.values(senderByAddr)[0]} />
            </div>
            <div className="flex justify-end px-5 py-3 border-t border-border">
              <Button size="sm" variant="outline" onClick={() => setComposeOpen(false)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
