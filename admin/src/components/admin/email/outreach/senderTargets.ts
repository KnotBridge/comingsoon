import { supabase } from "@/integrations/supabase/client";

// A "send from" target is EITHER one mailbox OR one group of mailboxes, never both.
// Everywhere that sends (flows, compose) picks a target through this module so the
// rules live in one place: one default across senders+groups, and a group resolves to
// the next mailbox in rotation.

export interface SenderLite {
  id: string;
  name: string;
  from_name?: string | null;
  from_email: string;
  smtp_host?: string | null;
  is_default?: boolean;
  is_active?: boolean;
  daily_limit?: number | null;
  group_id?: string | null;
  imap_enabled?: boolean;
  imap_host?: string | null;
}

export interface GroupLite {
  id: string;
  name: string;
  color: string;
  is_default?: boolean;
}

export const TARGET_DEFAULT = "__default__";

/** Encode the current selection for a <select>. Group wins if both are somehow set. */
export function targetValue(senderId?: string | null, groupId?: string | null): string {
  if (groupId) return `group:${groupId}`;
  if (senderId) return `sender:${senderId}`;
  return TARGET_DEFAULT;
}

/** Decode a <select> value back into the two mutually exclusive columns. */
export function parseTarget(v: string): { senderId: string | null; groupId: string | null } {
  if (v.startsWith("group:")) return { senderId: null, groupId: v.slice(6) };
  if (v.startsWith("sender:")) return { senderId: v.slice(7), groupId: null };
  return { senderId: null, groupId: null };
}

export async function fetchSenderTargets(): Promise<{ senders: SenderLite[]; groups: GroupLite[] }> {
  const [{ data: s }, { data: g }] = await Promise.all([
    supabase
      .from("email_sender_accounts")
      .select("id,name,from_name,from_email,smtp_host,is_default,is_active,daily_limit,group_id,imap_enabled,imap_host")
      .order("is_default", { ascending: false }),
    supabase.from("sender_groups" as any).select("id,name,color,is_default").order("created_at"),
  ]);
  return {
    senders: ((s as unknown as SenderLite[]) || []),
    groups: ((g as unknown as GroupLite[]) || []),
  };
}

/** Sends per mailbox since UTC midnight — the same window the daily cap resets on. */
export async function usageToday(): Promise<Record<string, number>> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const { data } = await supabase
    .from("email_queue")
    .select("sender_account_id")
    .eq("status", "sent")
    .gte("sent_at", midnight.toISOString())
    .not("sender_account_id", "is", null)
    .limit(10000);
  const map: Record<string, number> = {};
  for (const r of (data as { sender_account_id: string | null }[]) || []) {
    if (r.sender_account_id) map[r.sender_account_id] = (map[r.sender_account_id] || 0) + 1;
  }
  return map;
}

/**
 * One default across BOTH lists. Marking a group default clears the sender default and
 * vice versa, so "send from default" always resolves to exactly one thing.
 */
export async function setDefaultTarget(kind: "sender" | "group", id: string): Promise<void> {
  if (kind === "sender") {
    await supabase.from("email_sender_accounts").update({ is_default: false }).neq("id", id);
    const { error } = await supabase.from("email_sender_accounts").update({ is_default: true }).eq("id", id);
    if (error) throw error;
    await supabase.from("sender_groups" as any).update({ is_default: false } as any).neq("id", "00000000-0000-0000-0000-000000000000");
  } else {
    await supabase.from("sender_groups" as any).update({ is_default: false } as any).neq("id", id);
    const { error } = await supabase.from("sender_groups" as any).update({ is_default: true } as any).eq("id", id);
    if (error) throw error;
    await supabase.from("email_sender_accounts").update({ is_default: false }).neq("id", "00000000-0000-0000-0000-000000000000");
  }
}

/**
 * Resolve a group to the mailbox that should send next: active, still under today's cap,
 * least used first. That IS the rotation — each new send lands on the emptiest mailbox,
 * which spreads evenly without needing a stored cursor.
 */
export async function pickGroupSender(groupId: string): Promise<{ sender: SenderLite | null; reason?: string }> {
  const { senders } = await fetchSenderTargets();
  const members = senders.filter((s) => s.group_id === groupId);
  if (members.length === 0) return { sender: null, reason: "This group has no mailboxes in it yet." };
  const active = members.filter((s) => s.is_active !== false);
  if (active.length === 0) return { sender: null, reason: "Every mailbox in this group is paused." };
  const used = await usageToday();
  const available = active.filter((s) => (used[s.id] || 0) < (s.daily_limit ?? 50));
  if (available.length === 0) return { sender: null, reason: "Every mailbox in this group hit its daily limit. It resets at UTC midnight." };
  available.sort((a, b) => (used[a.id] || 0) - (used[b.id] || 0));
  return { sender: available[0] };
}

/** Human label for a target, for headers and chips. */
export function targetLabel(
  senderId: string | null | undefined,
  groupId: string | null | undefined,
  senders: SenderLite[],
  groups: GroupLite[],
): string {
  if (groupId) {
    const g = groups.find((x) => x.id === groupId);
    return g ? `${g.name} (group)` : "Unknown group";
  }
  if (senderId) {
    const s = senders.find((x) => x.id === senderId);
    return s ? s.from_email : "Unknown sender";
  }
  const dg = groups.find((x) => x.is_default);
  if (dg) return `Default: ${dg.name} (group)`;
  const ds = senders.find((x) => x.is_default);
  return ds ? `Default: ${ds.from_email}` : "Default sender";
}
