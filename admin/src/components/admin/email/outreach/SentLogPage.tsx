import { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { OutreachCampaign, OutreachAudience, ComposePrefill, FollowUpSegment } from "./types";
import { ChevronDown, ChevronRight, Eye, X, RefreshCw, Trash2, Reply, CornerDownRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useDynamicPageStats } from "@/hooks/useDynamicPageStats";
import { buildEmailPreviewSrcDoc } from "./emailPreview";
import FlowSentLog from "./FlowSentLog";

// The flow engine routes every flow email through one hidden bookkeeping campaign.
// It is not a real campaign, and its lumped counters make the click rate look
// wrong, so we keep it out of the campaign list and surface flows in their own view.
const FLOWS_INTERNAL_CAMPAIGN = "Flows (internal tracking)";

interface Props {
  audiences: OutreachAudience[];
  onFollowUp?: (prefill: ComposePrefill) => void;
}

interface QueueItem {
  id: string;
  recipient_email: string;
  recipient_name: string | null;
  status: string;
  sent_at: string | null;
  outreach_contact_id: string | null;
  html_body: string | null;
  subject: string | null;
  email_format?: string | null;
  tracking_image_url?: string | null;
}

interface EventRow {
  queue_item_id: string;
  event_type: string;
  created_at: string;
  user_agent: string | null;
}

// Status is a quiet word plus a small dot, not a filled pill.
const CAMPAIGN_STATUS_DOT: Record<string, string> = {
  draft: "bg-muted-foreground/40",
  sending: "bg-foreground/50",
  sent: "bg-emerald-500",
  scheduled: "bg-foreground/50",
  paused: "bg-muted-foreground/40",
};

function pct(n: number, total: number) {
  if (!total) return "—";
  return Math.round((Math.min(n, total) / total) * 100) + "%";
}

function ConversionCells({ campaignId, total }: { campaignId: string; total: number }) {
  const { stats, loading } = useDynamicPageStats(campaignId);
  if (loading) {
    return (
      <>
        <td className="px-3 py-2.5 text-xs text-muted-foreground">…</td>
        <td className="px-3 py-2.5 text-xs text-muted-foreground">…</td>
      </>
    );
  }
  if (!stats || stats.total === 0) {
    return (
      <>
        <td className="px-3 py-2.5 text-xs text-muted-foreground">—</td>
        <td className="px-3 py-2.5 text-xs text-muted-foreground">—</td>
      </>
    );
  }
  return (
    <>
      <td className="px-3 py-2.5 text-xs">
        {stats.signedIn > 0 ? (
          <span className="text-foreground font-medium">{stats.signedIn}</span>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
        <span className="text-muted-foreground/70 ml-1">({pct(stats.signedIn, total || stats.total)})</span>
      </td>
      <td className="px-3 py-2.5 text-xs">
        {stats.projectCreated > 0 ? (
          <span className="text-foreground font-medium">{stats.projectCreated}</span>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
        <span className="text-muted-foreground/70 ml-1">({pct(stats.projectCreated, total || stats.total)})</span>
      </td>
    </>
  );
}


export default function SentLogPage({ audiences, onFollowUp }: Props) {
  const [campaigns, setCampaigns] = useState<OutreachCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [previewItem, setPreviewItem] = useState<QueueItem | null>(null);
  const [resetting, setResetting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [followUpForId, setFollowUpForId] = useState<string | null>(null);
  const [followUpCounts, setFollowUpCounts] = useState<{ allEmails: string[]; openedEmails: string[]; clickedEmails: string[] } | null>(null);
  const [loadingFollowUp, setLoadingFollowUp] = useState(false);
  const [selectedSegment, setSelectedSegment] = useState<FollowUpSegment>("all");
  const [view, setView] = useState<"campaigns" | "flows">("campaigns");
  // Reply counts per campaign, from the new reply system (email_events 'reply' rows
  // tied to each campaign's sent queue items) — the same source the flow builder uses.
  const [replyByCampaign, setReplyByCampaign] = useState<Record<string, number>>({});
  // Hard-bounce counts per campaign, from ses-events 'bounce' rows on email_events.
  const [bounceByCampaign, setBounceByCampaign] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("outreach_campaigns")
      .select("*")
      .not("status", "eq", "draft")
      .order("created_at", { ascending: false });
    const rows = ((data as OutreachCampaign[]) || []).filter(c => c.name !== FLOWS_INTERNAL_CAMPAIGN);
    setCampaigns(rows);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Reply counts per campaign, sourced from email_events 'reply' rows (the reply
  // system attributes each reply to the exact send it answers). Distinct sent items
  // with a reply = replied recipients, so reply rate = replied / total_recipients.
  useEffect(() => {
    if (campaigns.length === 0) { setReplyByCampaign({}); setBounceByCampaign({}); return; }
    let cancelled = false;
    (async () => {
      const ids = campaigns.map((c) => c.id);
      const qidToCampaign = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 50) {
        const { data } = await supabase.from("email_queue")
          .select("id,outreach_campaign_id").in("outreach_campaign_id", ids.slice(i, i + 50)).eq("status", "sent");
        for (const r of (data as { id: string; outreach_campaign_id: string | null }[]) || []) {
          if (r.outreach_campaign_id) qidToCampaign.set(r.id, r.outreach_campaign_id);
        }
      }
      const qids = [...qidToCampaign.keys()];
      const replySets: Record<string, Set<string>> = {};
      const bounceSets: Record<string, Set<string>> = {};
      for (let i = 0; i < qids.length; i += 200) {
        const { data } = await supabase.from("email_events")
          .select("queue_item_id,event_type").in("event_type", ["reply", "bounce"]).in("queue_item_id", qids.slice(i, i + 200));
        for (const e of (data as { queue_item_id: string; event_type: string }[]) || []) {
          const cid = qidToCampaign.get(e.queue_item_id);
          if (!cid) continue;
          const target = e.event_type === "bounce" ? bounceSets : replySets;
          (target[cid] || (target[cid] = new Set())).add(e.queue_item_id);
        }
      }
      if (!cancelled) {
        setReplyByCampaign(Object.fromEntries(Object.entries(replySets).map(([k, v]) => [k, v.size])));
        setBounceByCampaign(Object.fromEntries(Object.entries(bounceSets).map(([k, v]) => [k, v.size])));
      }
    })();
    return () => { cancelled = true; };
  }, [campaigns]);

  const handleResetStuck = async () => {
    setResetting(true);
    try {
      // Reset all queue items stuck in "pending" with failed attempts back to pending with 0 attempts
      const { error } = await supabase
        .from("email_queue")
        .update({ status: "pending", attempts: 0, error_message: null, scheduled_for: new Date().toISOString() })
        .in("status", ["pending", "failed"])
        .not("outreach_campaign_id", "is", null);
      if (error) throw error;
      toast.success(`Stuck queue items reset — they'll retry with your new sender config`);
      await load();
    } catch (e: unknown) {
      toast.error("Reset failed: " + (e as Error).message);
    } finally {
      setResetting(false);
    }
  };

  const deleteCampaign = async (id: string) => {
    if (!confirm("Delete this campaign and all its queue items? This cannot be undone.")) return;
    setDeletingId(id);
    try {
      await supabase.from("outreach_replies").delete().eq("campaign_id", id);
      await supabase.from("email_queue").delete().eq("outreach_campaign_id", id);
      const { error } = await supabase.from("outreach_campaigns").delete().eq("id", id);
      if (error) throw error;
      setCampaigns(prev => prev.filter(c => c.id !== id));
      if (expandedId === id) setExpandedId(null);
      toast.success("Campaign deleted");
    } catch (e: unknown) {
      toast.error("Delete failed: " + (e as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  const toggleExpand = async (campaign: OutreachCampaign) => {
    if (expandedId === campaign.id) { setExpandedId(null); return; }
    setExpandedId(campaign.id);
    setLoadingDetail(true);

    const { data: items } = await supabase
      .from("email_queue")
      .select("id, recipient_email, recipient_name, status, sent_at, outreach_contact_id, html_body, subject, email_format, tracking_image_url")
      .eq("outreach_campaign_id", campaign.id)
      .order("sent_at", { ascending: false })
      .limit(200);

    const queueRows = (items as QueueItem[]) || [];
    setQueueItems(queueRows);

    if (queueRows.length > 0) {
      const { data: evts } = await supabase
        .from("email_events")
        .select("queue_item_id, event_type, created_at, user_agent")
        .in("queue_item_id", queueRows.map(i => i.id));
      setEvents((evts as EventRow[]) || []);
    }

    setLoadingDetail(false);
  };

  const getOpenedCount = (itemId: string) => events.filter(e => e.queue_item_id === itemId && e.event_type === "open").length;
  const getClickedCount = (itemId: string) => events.filter(e => e.queue_item_id === itemId && e.event_type === "click").length;

  const audienceLabel = (a: string | null) => {
    if (!a) return "—";
    return audiences.find(au => au.id === a)?.name || "—";
  };

  const campaignNameById = useMemo(() => {
    const m = new Map<string, string>();
    campaigns.forEach(c => m.set(c.id, c.name));
    return m;
  }, [campaigns]);

  const childCountByParent = useMemo(() => {
    const m = new Map<string, number>();
    campaigns.forEach(c => {
      if (c.parent_campaign_id) m.set(c.parent_campaign_id, (m.get(c.parent_campaign_id) || 0) + 1);
    });
    return m;
  }, [campaigns]);

  const SEGMENT_LABEL: Record<FollowUpSegment, string> = {
    all: "All recipients",
    opened: "Openers",
    clicked: "Clickers",
  };

  const openFollowUp = async (campaignId: string) => {
    setFollowUpForId(campaignId);
    setSelectedSegment("all");
    setFollowUpCounts(null);
    setLoadingFollowUp(true);
    try {
      const { data: sentItems } = await supabase
        .from("email_queue")
        .select("id, recipient_email, sent_at")
        .eq("outreach_campaign_id", campaignId)
        .eq("status", "sent");
      const sentRows = (sentItems as { id: string; recipient_email: string; sent_at: string | null }[]) || [];
      const queueIds = sentRows.map(r => r.id);
      const idToEmail = new Map(sentRows.map(r => [r.id, r.recipient_email.toLowerCase()]));
      const allEmails = Array.from(new Set(sentRows.map(r => r.recipient_email.toLowerCase())));

      let openedEmails: string[] = [];
      let clickedEmails: string[] = [];
      if (queueIds.length > 0) {
        const { data: evts } = await supabase
          .from("email_events")
          .select("queue_item_id, event_type, created_at, user_agent")
          .in("queue_item_id", queueIds);
        const opens = new Set<string>();
        const clicks = new Set<string>();
        ((evts as EventRow[]) || []).forEach(e => {
          const email = idToEmail.get(e.queue_item_id);
          if (!email) return;
          if (e.event_type === "open") opens.add(email);
          if (e.event_type === "click") clicks.add(email);
        });
        openedEmails = Array.from(opens);
        clickedEmails = Array.from(clicks);
      }
      setFollowUpCounts({ allEmails, openedEmails, clickedEmails });
    } catch (e) {
      toast.error("Could not load segments");
      setFollowUpForId(null);
    } finally {
      setLoadingFollowUp(false);
    }
  };

  const confirmFollowUp = () => {
    if (!followUpForId || !followUpCounts) return;
    const emails =
      selectedSegment === "all" ? followUpCounts.allEmails :
      selectedSegment === "opened" ? followUpCounts.openedEmails :
      followUpCounts.clickedEmails;
    if (emails.length === 0) {
      toast.error("No recipients in this segment");
      return;
    }
    const parent = campaigns.find(c => c.id === followUpForId);
    onFollowUp?.({
      emails,
      parentId: followUpForId,
      parentName: parent?.name || "previous campaign",
      segment: selectedSegment,
    });
    setFollowUpForId(null);
    setFollowUpCounts(null);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Campaigns vs Flows — flows route through one hidden campaign, so they need
          their own per-step, per-link view to read correctly. */}
      <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/30 p-0.5 w-fit">
        {(["campaigns", "flows"] as const).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={cn("px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors",
              view === v ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {v}
          </button>
        ))}
      </div>

      {view === "flows" ? <FlowSentLog /> : (
      <>
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-foreground">Sent campaigns</h3>
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">{campaigns.length} campaigns</p>
          <Button
            variant="outline"
            size="sm"
            onClick={handleResetStuck}
            disabled={resetting}
            className="text-xs h-7 px-2.5"
            title="Reset stuck queue items so they retry with your updated sender config"
          >
            {resetting ? <RefreshCw className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
            Reset stuck queue
          </Button>
        </div>
      </div>
      {loading && <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>}
      {!loading && campaigns.length === 0 && (
        <div className="text-center py-12 text-muted-foreground text-sm border border-dashed border-border rounded-xl">
          No campaigns sent yet. Use Compose to send your first outreach campaign.
        </div>
      )}

      <div className="border border-border rounded-xl overflow-hidden">
        {campaigns.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                 <th className="w-8 px-3 py-2" />
                 <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Campaign</th>
                 <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Audience</th>
                 <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Sent</th>
                 <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Opens</th>
                 <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Clicks</th>
                 <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Replies</th>
                 <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium" title="Hard bounces reported by Amazon SES. Suppressed so they won't be re-sent.">Bounced</th>
                 <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium" title="Recipients who signed in via the dynamic landing page">Signed in</th>
                 <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium" title="Recipients who completed project creation">Project</th>
                 <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Status</th>
                 <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Date</th>
                 <th className="w-8 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {campaigns.map(c => (
                <>
                  <tr key={c.id} className="border-b border-border/50 hover:bg-muted/20 cursor-pointer" onClick={() => toggleExpand(c)}>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {expandedId === c.id ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
                        {c.name}
                        {childCountByParent.get(c.id) ? (
                          <span className="text-[10px] text-muted-foreground font-medium">
                            ↳ {childCountByParent.get(c.id)} follow-up{childCountByParent.get(c.id)! > 1 ? "s" : ""}
                          </span>
                        ) : null}
                      </p>
                      {c.parent_campaign_id && (
                        <p className="text-[10px] text-muted-foreground/80 flex items-center gap-1 mt-0.5">
                          <CornerDownRight className="w-2.5 h-2.5" />
                          Follow-up to {campaignNameById.get(c.parent_campaign_id) || "deleted campaign"}
                          {c.follow_up_segment ? <span className="opacity-70">· {SEGMENT_LABEL[c.follow_up_segment as FollowUpSegment]}</span> : null}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground font-mono truncate max-w-[200px]">{c.subject}</p>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{audienceLabel(c.audience_id)}</td>
                    <td className="px-3 py-2.5 text-xs text-foreground">{c.total_recipients || "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{pct(c.open_count || 0, c.total_recipients || 0)}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{pct(c.click_count || 0, c.total_recipients || 0)}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {(() => {
                        const n = replyByCampaign[c.id] || 0;
                        return n > 0
                          ? <><span className="text-foreground font-medium">{n}</span> <span className="text-muted-foreground/70">({pct(n, c.total_recipients || 0)})</span></>
                          : <span className="text-muted-foreground">—</span>;
                      })()}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {(() => {
                        const n = bounceByCampaign[c.id] || 0;
                        const rate = c.total_recipients ? Math.round((Math.min(n, c.total_recipients) / c.total_recipients) * 100) : 0;
                        return n > 0
                          ? <span className={rate >= 5 ? "text-red-600 font-bold" : rate >= 2 ? "text-amber-600" : "text-foreground"}>{n} ({rate}%)</span>
                          : <span className="text-muted-foreground">—</span>;
                      })()}
                    </td>
                    <ConversionCells campaignId={c.id} total={c.total_recipients || 0} />
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className={cn("w-[7px] h-[7px] rounded-full flex-shrink-0", CAMPAIGN_STATUS_DOT[c.status] || "bg-muted-foreground/40")} />
                        {c.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {c.sent_at ? new Date(c.sent_at).toLocaleDateString() : c.created_at ? new Date(c.created_at).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        {onFollowUp && (
                          <button
                            onClick={() => openFollowUp(c.id)}
                            className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
                            title="Create follow-up campaign"
                          >
                            <Reply className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => deleteCampaign(c.id)}
                          disabled={deletingId === c.id}
                          className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-destructive transition-colors"
                          title="Delete campaign"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>

                  {expandedId === c.id && (
                    <tr key={c.id + "-detail"}>
                      <td colSpan={13} className="px-4 py-3 bg-muted/10 border-b border-border">
                        {loadingDetail ? (
                          <p className="text-xs text-muted-foreground py-2">Loading detail…</p>
                        ) : queueItems.length === 0 ? (
                          <p className="text-xs text-muted-foreground py-2">No queue items found</p>
                        ) : (
                          <div className="border border-border rounded-lg overflow-hidden">
                            <table className="w-full text-xs">
                              <thead className="bg-muted/40 border-b border-border">
                                <tr>
                                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">Contact</th>
                                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">Status</th>
                                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">Sent at</th>
                                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">Opens</th>
                                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">Clicks</th>
                                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">Action</th>
                                </tr>
                              </thead>
                              <tbody>
                                 {queueItems.map(item => {
                                   const opens = getOpenedCount(item.id);
                                   const clicks = getClickedCount(item.id);
                                   return (
                                     <tr key={item.id} className="border-b border-border/50 last:border-0">
                                       <td className="px-3 py-2">
                                         <p className="font-medium text-foreground">{item.recipient_name || "—"}</p>
                                         <p className="text-muted-foreground">{item.recipient_email}</p>
                                       </td>
                                        <td className="px-3 py-2">
                                          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                            <span className={cn("w-[7px] h-[7px] rounded-full flex-shrink-0",
                                              item.status === "sent" ? "bg-emerald-500" :
                                              item.status === "sending" ? "bg-foreground/50" :
                                              "bg-muted-foreground/40"
                                            )} />
                                            {item.status}
                                          </span>
                                        </td>
                                       <td className="px-3 py-2 text-muted-foreground">
                                         {item.sent_at ? new Date(item.sent_at).toLocaleTimeString() : "—"}
                                       </td>
                                       <td className="px-3 py-2">
                                         {opens > 0 ? <span className="text-foreground font-medium">✓ {opens}</span> : <span className="text-muted-foreground">—</span>}
                                       </td>
                                       <td className="px-3 py-2">
                                         {clicks > 0 ? <span className="text-foreground font-medium">✓ {clicks}</span> : <span className="text-muted-foreground">—</span>}
                                       </td>
                                       <td className="px-3 py-2">
                                         <div className="flex items-center gap-1.5">
                                           {item.html_body && (
                                             <button
                                               className="text-xs px-2 py-1 rounded border border-border hover:bg-muted/60 transition-colors text-muted-foreground flex items-center gap-1"
                                               onClick={() => setPreviewItem(item)}
                                               title="Preview email"
                                             >
                                               <Eye className="w-3 h-3" /> Preview
                                             </button>
                                           )}
                                           {item.outreach_contact_id && (
                                             <button
                                               className="text-xs px-2 py-1 rounded border border-border hover:bg-muted/60 transition-colors text-muted-foreground"
                                               onClick={async () => {
                                                 await supabase.from("outreach_contacts").update({ status: "replied" }).eq("id", item.outreach_contact_id!);
                                                 await supabase.from("outreach_replies").insert({
                                                   contact_id: item.outreach_contact_id,
                                                   campaign_id: c.id,
                                                   direction: "inbound",
                                                   body: "Manually marked as replied",
                                                   queue_item_id: item.id,
                                                 });
                                                 // Feed the reply rate the same way auto-captured replies do.
                                                 await supabase.from("email_events").insert({
                                                   queue_item_id: item.id, campaign_id: c.id, recipient_email: item.recipient_email, event_type: "reply",
                                                 });
                                                 setReplyByCampaign((prev) => ({ ...prev, [c.id]: (prev[c.id] || 0) + 1 }));
                                                 toast.success("Marked as replied");
                                               }}
                                             >
                                               Mark replied
                                             </button>
                                           )}
                                         </div>
                                       </td>
                                     </tr>
                                   );
                                 })}
                               </tbody>
                             </table>
                           </div>
                         )}
                       </td>
                     </tr>
                   )}
                 </>
               ))}
             </tbody>
           </table>
         )}
       </div>

      {/* Email Preview Modal */}
      {previewItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-card border border-border rounded-2xl shadow-lg w-full max-w-2xl flex flex-col" style={{ maxHeight: "85vh" }}>
            <div className="flex items-start justify-between px-5 py-4 border-b border-border flex-shrink-0">
              <div>
                <p className="font-medium text-sm text-foreground">{previewItem.subject || "(no subject)"}</p>
                <p className="text-xs text-muted-foreground mt-0.5">To: {previewItem.recipient_name} &lt;{previewItem.recipient_email}&gt;</p>
                {previewItem.sent_at && (
                  <p className="text-xs text-muted-foreground/60 mt-0.5">Sent: {new Date(previewItem.sent_at).toLocaleString()}</p>
                )}
              </div>
              <button onClick={() => setPreviewItem(null)} className="text-muted-foreground hover:text-foreground ml-4 flex-shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <iframe
                srcDoc={buildEmailPreviewSrcDoc({ body: previewItem.html_body || "", format: previewItem.email_format, trackingImageUrl: previewItem.tracking_image_url, fill: (s) => s })}
                className="w-full h-full border-0"
                style={{ minHeight: "500px" }}
                sandbox="allow-same-origin"
                title="Email preview"
              />
            </div>
          </div>
        </div>
      )}

      {/* Follow-up segment picker */}
      {followUpForId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setFollowUpForId(null)}>
          <div className="bg-card border border-border rounded-2xl shadow-lg w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-medium text-foreground text-base">Create follow-up campaign</h3>
                <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[320px]">
                  From: {campaigns.find(c => c.id === followUpForId)?.name}
                </p>
              </div>
              <button onClick={() => setFollowUpForId(null)} className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>

            {loadingFollowUp || !followUpCounts ? (
              <p className="text-sm text-muted-foreground py-6 text-center">Loading recipient segments…</p>
            ) : (
              <>
                <p className="text-xs font-medium text-muted-foreground mb-2">Send to:</p>
                <div className="flex flex-col gap-2">
                  {([
                    { key: "all" as FollowUpSegment, label: "All recipients", count: followUpCounts.allEmails.length, hint: "Everyone who received the original" },
                    { key: "opened" as FollowUpSegment, label: "Openers only", count: followUpCounts.openedEmails.length, hint: "People who opened the email" },
                    { key: "clicked" as FollowUpSegment, label: "Clickers only", count: followUpCounts.clickedEmails.length, hint: "People who clicked a link" },
                  ]).map(opt => (
                    <button
                      key={opt.key}
                      onClick={() => setSelectedSegment(opt.key)}
                      disabled={opt.count === 0}
                      className={cn(
                        "flex items-center justify-between text-left px-3 py-2.5 rounded-lg border transition-colors",
                        selectedSegment === opt.key ? "border-primary bg-primary/10" : "border-border hover:bg-muted/40",
                        opt.count === 0 && "opacity-40 cursor-not-allowed"
                      )}
                    >
                      <div>
                        <p className="text-sm font-medium text-foreground">{opt.label}</p>
                        <p className="text-xs text-muted-foreground">{opt.hint}</p>
                      </div>
                      <span className="text-sm font-medium text-foreground tabular-nums">{opt.count}</span>
                    </button>
                  ))}
                </div>

                <div className="flex justify-end gap-2 mt-5">
                  <Button variant="outline" size="sm" onClick={() => setFollowUpForId(null)}>Cancel</Button>
                  <Button size="sm" onClick={confirmFollowUp}>
                    Continue in Compose
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
