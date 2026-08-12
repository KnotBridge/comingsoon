import { supabase } from "@/integrations/supabase/client";

// Per-mailbox bounce rate, and the rule that decides when to pause a mailbox before its
// bounces put the whole SES account at risk. The same numbers feed the display in the
// Senders tab and the automatic pause in the send worker, so the UI and the enforcement
// can never disagree about what a mailbox's rate is.

export interface GuardSettings {
  enabled: boolean;
  threshold_pct: number;
  min_sample: number;
  lookback_days: number;
}

export const DEFAULT_GUARD: GuardSettings = { enabled: true, threshold_pct: 5, min_sample: 20, lookback_days: 30 };

export interface SenderBounce {
  senderId: string;
  sent: number;
  bounced: number;
  rate: number; // 0..1
}

export async function fetchGuardSettings(): Promise<GuardSettings> {
  const { data } = await supabase.from("outreach_guard_settings" as any).select("*").eq("id", 1).maybeSingle();
  if (!data) return DEFAULT_GUARD;
  const d = data as unknown as GuardSettings;
  return {
    enabled: d.enabled ?? true,
    threshold_pct: d.threshold_pct ?? 5,
    min_sample: d.min_sample ?? 20,
    lookback_days: d.lookback_days ?? 30,
  };
}

export async function saveGuardSettings(s: GuardSettings): Promise<void> {
  const { error } = await supabase.from("outreach_guard_settings" as any)
    .update({ enabled: s.enabled, threshold_pct: s.threshold_pct, min_sample: s.min_sample, lookback_days: s.lookback_days })
    .eq("id", 1);
  if (error) throw error;
}

// Sent count and hard-bounce count per mailbox over the lookback window. Sent comes from
// email_queue (the mailbox that sent it), bounces from email_events 'bounce' rows mapped
// back to their queue item's sender. Distinct queue items with a bounce = bounced sends,
// so the rate is bounced / sent, the same definition SES uses.
export async function fetchSenderBounces(senderIds: string[], lookbackDays: number): Promise<Record<string, SenderBounce>> {
  const out: Record<string, SenderBounce> = {};
  for (const id of senderIds) out[id] = { senderId: id, sent: 0, bounced: 0, rate: 0 };
  if (senderIds.length === 0) return out;

  const since = new Date(Date.now() - lookbackDays * 86400_000).toISOString();

  // Sent per sender, and remember each sent item so a bounce can be attributed to it.
  const qidToSender = new Map<string, string>();
  for (let i = 0; i < senderIds.length; i += 40) {
    const slice = senderIds.slice(i, i + 40);
    // Page through: a mailbox can have thousands of sends in the window.
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase.from("email_queue")
        .select("id,sender_account_id")
        .in("sender_account_id", slice)
        .eq("status", "sent")
        .gte("sent_at", since)
        .range(from, from + 999);
      const rows = (data as { id: string; sender_account_id: string | null }[]) || [];
      for (const r of rows) {
        if (!r.sender_account_id) continue;
        out[r.sender_account_id].sent++;
        qidToSender.set(r.id, r.sender_account_id);
      }
      if (rows.length < 1000) break;
    }
  }

  // Bounces among those exact sent items.
  const qids = [...qidToSender.keys()];
  const counted = new Set<string>();
  for (let i = 0; i < qids.length; i += 200) {
    const { data } = await supabase.from("email_events")
      .select("queue_item_id,event_type")
      .eq("event_type", "bounce")
      .in("queue_item_id", qids.slice(i, i + 200));
    for (const e of (data as { queue_item_id: string }[]) || []) {
      if (counted.has(e.queue_item_id)) continue; // one bounce per send
      counted.add(e.queue_item_id);
      const sid = qidToSender.get(e.queue_item_id);
      if (sid) out[sid].bounced++;
    }
  }

  for (const id of senderIds) {
    const b = out[id];
    b.rate = b.sent > 0 ? b.bounced / b.sent : 0;
  }
  return out;
}

// Is this mailbox over the line? Needs enough sample so one bounce out of three does not
// trip it.
export function isOverThreshold(b: SenderBounce | undefined, s: GuardSettings): boolean {
  if (!b || !s.enabled) return false;
  return b.sent >= s.min_sample && b.rate * 100 >= s.threshold_pct;
}

export const ratePct = (b: SenderBounce | undefined): number => (b ? Math.round(b.rate * 1000) / 10 : 0);
