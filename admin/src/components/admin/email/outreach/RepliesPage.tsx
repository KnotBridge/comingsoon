import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { invokeFn } from "@/integrations/functions";
import { toast } from "sonner";
import type { OutreachAudience } from "./types";
import { MessageSquareReply, X, Send, ChevronDown, ChevronUp, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

interface Props {
  audiences: OutreachAudience[];
}

interface ReplyContact {
  id: string;
  name: string;
  email: string;
  username: string | null;
  last_contacted_at: string | null;
  status: string | null;
}

interface OutreachReplyRow {
  id: string;
  contact_id: string;
  campaign_id: string | null;
  direction: string;
  subject: string | null;
  body: string | null;
  replied_at: string;
  outreach_campaigns?: { name: string; subject: string } | null;
}

interface OriginalEmail {
  id: string;
  subject: string;
  html_body: string;
  campaign_name: string;
  sent_at: string | null;
}

interface ReplyThread {
  contact: ReplyContact;
  replies: OutreachReplyRow[];
  latestCampaign: string | null;
  latestCampaignSubject: string | null;
}

function OriginalEmailCard({ email }: { email: OriginalEmail }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden mt-3">
      <button
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-muted/60 transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <Mail className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-foreground truncate">{email.subject}</p>
          <p className="text-xs text-muted-foreground/60">Campaign: {email.campaign_name} · {email.sent_at ? formatDistanceToNow(new Date(email.sent_at), { addSuffix: true }) : "queued"}</p>
        </div>
        {expanded
          ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground/50 flex-shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/50 flex-shrink-0" />
        }
      </button>
      {expanded && (
        <div className="border-t border-border">
          <iframe
            srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;font-family:sans-serif;font-size:14px;color:#111;}</style></head><body>${email.html_body}</body></html>`}
            sandbox="allow-same-origin"
            className="w-full min-h-[280px] border-0"
            style={{ display: "block" }}
            onLoad={(e) => {
              const iframe = e.currentTarget;
              try {
                const body = iframe.contentDocument?.body;
                if (body) {
                  iframe.style.height = Math.min(body.scrollHeight + 32, 560) + "px";
                }
              } catch {}
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function RepliesPage({ audiences }: Props) {
  const [threads, setThreads] = useState<ReplyThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ReplyThread | null>(null);
  const [replySubject, setReplySubject] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [sending, setSending] = useState(false);
  const [showMarkModal, setShowMarkModal] = useState<ReplyContact | null>(null);
  const [markBody, setMarkBody] = useState("");
  const [marking, setMarking] = useState(false);
  const [senders, setSenders] = useState<{ id: string; from_name: string; from_email: string; is_default: boolean }[]>([]);
  const [senderId, setSenderId] = useState("");
  // Original emails per contact (keyed by contact id)
  const [originalEmails, setOriginalEmails] = useState<Record<string, OriginalEmail[]>>({});

  const load = useCallback(async () => {
    setLoading(true);

    const { data: contacts } = await supabase
      .from("outreach_contacts")
      .select("id, name, email, username, last_contacted_at, status")
      .eq("status", "replied")
      .order("last_contacted_at", { ascending: false });

    if (!contacts?.length) { setThreads([]); setLoading(false); return; }

    const contactIds = contacts.map((c: ReplyContact) => c.id);
    const { data: replies } = await supabase
      .from("outreach_replies")
      .select("*, outreach_campaigns(name, subject)")
      .in("contact_id", contactIds)
      .order("replied_at", { ascending: true });

    const repliesData = (replies as OutreachReplyRow[]) || [];

    const built: ReplyThread[] = contacts.map((c: ReplyContact) => {
      const cReplies = repliesData.filter(r => r.contact_id === c.id);
      const latest = cReplies.slice().reverse().find(r => r.campaign_id);
      return {
        contact: c,
        replies: cReplies,
        latestCampaign: latest?.outreach_campaigns?.name || null,
        latestCampaignSubject: latest?.outreach_campaigns?.subject || null,
      };
    });

    setThreads(built);
    setLoading(false);
  }, []);

  const loadOriginalEmails = useCallback(async (contact: ReplyContact) => {
    const { data: queueItems } = await supabase
      .from("email_queue")
      .select("id, subject, html_body, sent_at, outreach_campaign_id")
      .eq("recipient_email", contact.email)
      .not("outreach_campaign_id", "is", null)
      .order("sent_at", { ascending: true })
      .limit(50);

    if (!queueItems?.length) return;

    const campaignIds = [...new Set(queueItems.map((q: Record<string, unknown>) => q.outreach_campaign_id as string).filter(Boolean))];
    let campaignMap: Record<string, string> = {};
    if (campaignIds.length > 0) {
      const { data: camps } = await supabase.from("outreach_campaigns").select("id, name").in("id", campaignIds);
      campaignMap = Object.fromEntries((camps || []).map((c: { id: string; name: string }) => [c.id, c.name]));
    }

    const emails: OriginalEmail[] = queueItems
      .filter((q: Record<string, unknown>) => q.html_body)
      .map((q: Record<string, unknown>) => ({
        id: q.id as string,
        subject: q.subject as string,
        html_body: q.html_body as string,
        campaign_name: campaignMap[q.outreach_campaign_id as string] || "Campaign",
        sent_at: (q.sent_at as string | null),
      }));

    setOriginalEmails(prev => ({ ...prev, [contact.id]: emails }));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    supabase.from("email_sender_accounts").select("id, from_name, from_email, is_default").then(({ data }) => {
      const rows = (data as { id: string; from_name: string; from_email: string; is_default: boolean }[]) || [];
      setSenders(rows);
      const def = rows.find(s => s.is_default);
      if (def) setSenderId(def.id);
    });
  }, []);

  const openReplyModal = (thread: ReplyThread) => {
    setSelected(thread);
    setReplySubject(thread.latestCampaignSubject ? `Re: ${thread.latestCampaignSubject}` : "");
    setReplyBody("");
    // Load original emails for this contact if not already loaded
    if (!originalEmails[thread.contact.id]) {
      loadOriginalEmails(thread.contact);
    }
  };

  const sendReply = async () => {
    if (!selected || !replyBody.trim()) { toast.error("Reply body required"); return; }
    setSending(true);

    const { data: campaign, error: cErr } = await supabase.from("outreach_campaigns").insert({
      name: `Reply to ${selected.contact.name} — ${new Date().toLocaleDateString()}`,
      subject: replySubject || "Follow-up",
      body_html: replyBody,
      sender_account_id: senderId || null,
      contact_emails: [selected.contact.email],
      track_replies: true,
      status: "draft",
    }).select().single();

    if (cErr || !campaign) { toast.error("Failed to create reply campaign"); setSending(false); return; }

    const { error: fnErr } = await invokeFn("send-outreach", {
      body: { outreach_campaign_id: campaign.id },
    });

    if (fnErr) { toast.error("Send failed: " + fnErr.message); setSending(false); return; }

    await supabase.from("outreach_replies").insert({
      contact_id: selected.contact.id,
      campaign_id: campaign.id,
      direction: "outbound",
      subject: replySubject,
      body: replyBody,
    });

    toast.success("Reply sent");
    setSending(false);
    setSelected(null);
    load();
  };

  const openMarkModal = (contact: ReplyContact) => {
    setShowMarkModal(contact);
    setMarkBody("");
  };

  const markAsReplied = async () => {
    if (!showMarkModal) return;
    setMarking(true);

    await supabase.from("outreach_contacts").update({ status: "replied" }).eq("id", showMarkModal.id);
    await supabase.from("outreach_replies").insert({
      contact_id: showMarkModal.id,
      direction: "inbound",
      body: markBody || "Reply recorded manually",
    });

    toast.success(`${showMarkModal.name} marked as replied`);
    setMarking(false);
    setShowMarkModal(null);
    load();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-foreground">Replies inbox</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Contacts who replied to your outreach campaigns</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{threads.length} replied</span>
          <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>}

      {!loading && threads.length === 0 && (
        <div className="text-center py-16 border border-dashed border-border/50 rounded-lg">
          <MessageSquareReply className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No replies yet</p>
          <p className="text-xs text-muted-foreground mt-1">When contacts reply (or are marked as replied), they'll appear here.</p>
        </div>
      )}

      <div className="divide-y divide-border/50">
        {threads.map(thread => (
          <div key={thread.contact.id} className="py-4 hover:bg-muted/40 transition-colors">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center flex-shrink-0 text-sm font-medium text-muted-foreground">
                  {thread.contact.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-sm text-foreground">{thread.contact.name}</p>
                    {thread.contact.username && <span className="text-xs text-muted-foreground">@{thread.contact.username}</span>}
                    <span className="text-xs text-muted-foreground">{thread.contact.email}</span>
                  </div>
                  {thread.latestCampaign && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Campaign: <span className="text-foreground font-medium">{thread.latestCampaign}</span>
                    </p>
                  )}

                  {/* Replies thread */}
                  {thread.replies.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {thread.replies.map(r => (
                        <div key={r.id} className={cn(
                          "text-xs rounded-lg px-3 py-2.5 max-w-2xl border border-border/50",
                          r.direction === "inbound"
                            ? "bg-muted/40 text-foreground"
                            : "bg-muted/20 text-foreground ml-6"
                        )}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-xs text-muted-foreground">
                              {r.direction === "inbound" ? "↙ Their reply" : "↗ Your reply"}
                            </span>
                            {r.subject && <span className="text-muted-foreground/70 truncate">{r.subject}</span>}
                            <span className="text-muted-foreground/50 ml-auto flex-shrink-0">
                              {formatDistanceToNow(new Date(r.replied_at), { addSuffix: true })}
                            </span>
                          </div>
                          {r.body && <p className="text-foreground/80 leading-relaxed line-clamp-3">{r.body}</p>}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Original emails sent to this contact */}
                  {originalEmails[thread.contact.id]?.map(email => (
                    <OriginalEmailCard key={email.id} email={email} />
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {thread.contact.last_contacted_at && (
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDistanceToNow(new Date(thread.contact.last_contacted_at), { addSuffix: true })}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs h-7 px-2.5"
                  onClick={() => {
                    openMarkModal(thread.contact);
                    if (!originalEmails[thread.contact.id]) loadOriginalEmails(thread.contact);
                  }}
                >
                  Mark replied
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5 text-xs h-7 px-2.5" onClick={() => openReplyModal(thread)}>
                  <MessageSquareReply className="w-3 h-3" />
                  Reply
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Reply modal with original emails */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={() => setSelected(null)}>
          <div className="bg-card rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
              <div>
                <h3 className="font-medium text-foreground">Reply to {selected.contact.name}</h3>
                <p className="text-xs text-muted-foreground">{selected.contact.email}</p>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 px-6 py-4">
              {/* Original emails */}
              {(originalEmails[selected.contact.id]?.length ?? 0) > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Emails sent to this contact</p>
                  {originalEmails[selected.contact.id].map(email => (
                    <OriginalEmailCard key={email.id} email={email} />
                  ))}
                </div>
              )}

              <div className="flex flex-col gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">From</label>
                  <select value={senderId} onChange={e => setSenderId(e.target.value)} className="w-full h-9 text-sm border border-input rounded-md px-3 bg-background">
                    {senders.map(s => <option key={s.id} value={s.id}>{s.from_name} &lt;{s.from_email}&gt;</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Subject</label>
                  <Input value={replySubject} onChange={e => setReplySubject(e.target.value)} className="text-sm" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Message</label>
                  <Textarea
                    value={replyBody}
                    onChange={e => setReplyBody(e.target.value)}
                    placeholder="Type your reply…"
                    className="text-sm min-h-[140px] resize-y"
                    autoFocus
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-2 justify-end px-6 py-4 border-t border-border flex-shrink-0">
              <Button variant="outline" size="sm" onClick={() => setSelected(null)}>Cancel</Button>
              <Button size="sm" onClick={sendReply} disabled={sending} className="gap-1.5">
                <Send className="w-3.5 h-3.5" />
                {sending ? "Sending…" : "Send reply"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Mark as replied modal */}
      {showMarkModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={() => setShowMarkModal(null)}>
          <div className="bg-card rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium text-foreground">Mark as replied</h3>
              <button
                onClick={() => setShowMarkModal(null)}
                className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              Mark <strong className="text-foreground">{showMarkModal.name}</strong> as having replied. Optionally paste their reply below.
            </p>
            <Textarea
              value={markBody}
              onChange={e => setMarkBody(e.target.value)}
              placeholder="Paste their reply here (optional)…"
              className="text-sm min-h-[100px] mb-3"
            />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowMarkModal(null)}>Cancel</Button>
              <Button size="sm" onClick={markAsReplied} disabled={marking}>
                {marking ? "Saving…" : "Mark replied"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
