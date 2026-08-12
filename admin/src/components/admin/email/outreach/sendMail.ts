import { supabase } from "@/integrations/supabase/client";

// Send an email straight through the existing, deployed worker (process-email-queue):
// insert a queue row (admins are allowed by RLS) with tracking baked in, then kick the
// worker so it goes out now. The worker also mirrors it into mailbox_messages, so it
// shows in the Mailbox thread. This avoids depending on a separately-deployed function.

const FB = "https://akfggpfvpiozrwcvvyxi.supabase.co/functions/v1";

// Fill the persona tags from the mailbox that sends this email, at queue time — so the
// stored copy already reads "Justin" and it does NOT depend on the send worker having the
// same logic deployed. {{sender_name}} and {{sender_full_name}} both give the full From
// name; first/last split on whitespace ("Justin H." → "Justin" / "H.").
export function applySenderTags(text: string, fromName?: string | null, fromEmail?: string | null): string {
  if (!text) return text || "";
  const full = (fromName || "").trim();
  const parts = full.split(/\s+/).filter(Boolean);
  return text
    .replace(/\{\{\s*sender_(?:full_)?name\s*\}\}/gi, full)
    .replace(/\{\{\s*sender_first_name\s*\}\}/gi, parts[0] || "")
    .replace(/\{\{\s*sender_last_name\s*\}\}/gi, parts.slice(1).join(" "))
    .replace(/\{\{\s*sender_email\s*\}\}/gi, (fromEmail || "").trim());
}

export async function queueAndSend(
  to: string,
  subject: string,
  html: string,
  // For a real reply: In-Reply-To = the Message-ID being answered; References = the
  // thread's Message-ID chain. The worker turns these into SMTP headers so the
  // recipient's client threads it as a reply, not a new email.
  // fromAddress: reply through the SENDER whose From matches this address (the one the
  // conversation is on), so the reply goes out the same mailbox the prospect sees,
  // via that sender's own SMTP. Falls back to the default sender if not matched.
  // plainText: send as raw text (no HTML). includeUnsubscribe: add the unsubscribe
  // footer/header — default OFF for replies/personal sends (a reply should have no
  // unsubscribe). trackOpens: keep the open pixel (default on).
  opts?: {
    inReplyTo?: string | null; references?: string | null; fromAddress?: string | null;
    plainText?: boolean; includeUnsubscribe?: boolean; trackOpens?: boolean;
    trackingImageUrl?: string | null; templateId?: string | null;
  },
  // Returns the queue-item id so the caller can watch this exact send land.
): Promise<string> {
  const addr = (to || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw new Error(`Invalid recipient: ${to}`);
  if (!html.trim()) throw new Error("Empty message");

  // Pick a sender. Prefer the exact account whose From matches fromAddress (reply from
  // the thread's own mailbox/SMTP); otherwise the default, preferring an Amazon SES one.
  const { data: senders } = await supabase.from("email_sender_accounts").select("id,is_default,smtp_host,from_email,from_name");
  const list = (senders as any[]) || [];
  const isSes = (s: any) => /amazonaws|amazon|ses/i.test(s.smtp_host || "");
  const want = (opts?.fromAddress || "").trim().toLowerCase();
  const matched = want ? list.find((s) => (s.from_email || "").trim().toLowerCase() === want) : null;
  const sender = matched
    || list.find((s) => s.is_default && isSes(s)) || list.find(isSes) || list.find((s) => s.is_default) || list[0] || null;
  const senderId = sender?.id || null;

  // Fill persona tags from the chosen mailbox before queueing.
  const finalSubject = applySenderTags(subject || "(no subject)", sender?.from_name, sender?.from_email);
  const finalHtml = applySenderTags(html, sender?.from_name, sender?.from_email);

  const queueId = crypto.randomUUID();
  const token = crypto.randomUUID();
  // Cast: in_reply_to / references_header are newer columns not yet in the generated
  // Supabase types.
  // The open pixel is added by the send worker (so it works even in plain-text mode),
  // so we store the body as-is here.
  const { error } = await supabase.from("email_queue").insert({
    id: queueId,
    recipient_email: addr,
    subject: finalSubject,
    html_body: finalHtml,
    tracking_token: token,
    status: "pending",
    scheduled_for: new Date().toISOString(),
    queue_type: "campaign",
    sender_account_id: senderId,
    in_reply_to: opts?.inReplyTo || null,
    references_header: opts?.references || null,
    email_format: opts?.plainText ? "plain" : "html",
    track_opens: opts?.trackOpens !== false,
    include_unsubscribe: opts?.includeUnsubscribe === true,
    tracking_image_url: opts?.trackingImageUrl || null,
    template_id: opts?.templateId || null,
  } as any);
  if (error) throw new Error(error.message);

  // Kick the worker so it sends within seconds instead of waiting for the cron.
  supabase.functions.invoke("process-email-queue", { body: {} }).catch(() => { /* cron will catch it */ });
  return queueId;
}

// ---------------------------------------------------------------------------
// Outreach campaign send (Compose "Send now").
//
// This is a faithful, browser-side port of the send-outreach edge function,
// which is not deployed on the platform (404 NOT_FOUND_FUNCTION_BLOB). Rather
// than depend on it, we expand the campaign into email_queue rows directly —
// the exact same path queueAndSend uses (admins can insert per RLS) and that
// the deployed, healthy process-email-queue worker drains. Nothing is lost:
// per-recipient dynamic landing pages ({{dynamic_page_url}}) and one-click
// instant-login links ({{instant_login_url}}) are still provisioned here, and
// admins have RLS to write outreach_dynamic_pages + campaign_magic_tokens.
// ---------------------------------------------------------------------------

// Where the public /r/<token> landing pages and /outreach/unsubscribe live.
// Hardcoded (not window.location.origin) because the admin app may run on a
// preview domain, which would bake broken links into real outreach emails.
const PUBLIC_APP_URL = "https://renov.space";
const FREE_WINDOW_DAYS = 7;

function formatFollowers(n: number | null): string {
  if (!n) return "";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return n.toString();
}
function formatMoney(n: unknown): string {
  if (n == null || n === "") return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  return "$" + Math.round(num).toLocaleString("en-US");
}
function formatNumber(n: unknown): string {
  if (n == null || n === "") return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  return Math.round(num).toLocaleString("en-US");
}

function repairDuplicateUrlProtocols(value: string): string {
  return value.replace(/(?:https?:\/\/)+(?=https?:\/\/)/gi, "");
}

function substituteOutreachVars(
  template: string,
  contact: Record<string, unknown>,
  campaignId: string,
  dynamicPageToken?: string,
  instantLoginUrl?: string,
  deadlineLabel?: string,
): string {
  const unsubUrl = `${PUBLIC_APP_URL}/outreach/unsubscribe?email=${encodeURIComponent(String(contact.email || ""))}&cid=${campaignId}`;
  const dynamicUrl = dynamicPageToken ? `${PUBLIC_APP_URL}/r/${dynamicPageToken}` : "";
  const bio = typeof contact.bio === "string" ? contact.bio : "";
  const name = typeof contact.name === "string" ? contact.name : "";
  const username = typeof contact.username === "string" ? contact.username : "";
  const platform = typeof contact.platform === "string" ? contact.platform : "";
  const profileUrl = typeof contact.profile_url === "string" ? contact.profile_url : "";
  const streetAddress = typeof contact.street_address === "string" ? contact.street_address : "";
  const city = typeof contact.city === "string" ? contact.city : "";
  const state = typeof contact.property_state === "string" ? contact.property_state : "";
  const zip = typeof contact.property_zip === "string" ? contact.property_zip : "";
  const propertyType = typeof contact.property_type === "string" ? contact.property_type : "";
  const yearBuilt = contact.property_year_built != null ? String(contact.property_year_built) : "";
  const bedrooms = contact.property_bedrooms != null ? String(contact.property_bedrooms) : "";
  const bathrooms = contact.property_bathrooms != null ? String(contact.property_bathrooms) : "";
  const sqft = formatNumber(contact.property_square_feet);
  const listingAmount = formatMoney(contact.listing_amount);
  const daysOnMarket = contact.days_on_market != null ? String(contact.days_on_market) : "";
  const agentName = typeof contact.agent_name === "string" ? contact.agent_name : "";
  const agentFirst = agentName.split(" ")[0] || name.split(" ")[0] || "";

  return repairDuplicateUrlProtocols(template
    .replace(/\{\{name\}\}/g, name)
    .replace(/\{\{first_name\}\}/g, name.split(" ")[0] || "")
    .replace(/\{\{agent_first_name\}\}/g, agentFirst)
    .replace(/\{\{agent_name\}\}/g, agentName)
    .replace(/\{\{username\}\}/g, username ? `@${username}` : "")
    .replace(/\{\{followers\}\}/g, formatFollowers(contact.followers as number | null))
    .replace(/\{\{platform\}\}/g, platform)
    .replace(/\{\{bio_snippet\}\}/g, bio.substring(0, 80))
    .replace(/\{\{profile_url\}\}/g, profileUrl)
    .replace(/\{\{street_address\}\}/g, streetAddress)
    .replace(/\{\{property_address\}\}/g, streetAddress)
    .replace(/\{\{listingCity\}\}/g, city)
    .replace(/\{\{city\}\}/g, city)
    .replace(/\{\{state\}\}/g, state)
    .replace(/\{\{property_state\}\}/g, state)
    .replace(/\{\{zip\}\}/g, zip)
    .replace(/\{\{property_zip\}\}/g, zip)
    .replace(/\{\{property_type\}\}/g, propertyType)
    .replace(/\{\{year_built\}\}/g, yearBuilt)
    .replace(/\{\{property_year_built\}\}/g, yearBuilt)
    .replace(/\{\{bedrooms\}\}/g, bedrooms)
    .replace(/\{\{property_bedrooms\}\}/g, bedrooms)
    .replace(/\{\{bathrooms\}\}/g, bathrooms)
    .replace(/\{\{property_bathrooms\}\}/g, bathrooms)
    .replace(/\{\{square_feet\}\}/g, sqft)
    .replace(/\{\{property_square_feet\}\}/g, sqft)
    .replace(/\{\{sqft\}\}/g, sqft)
    .replace(/\{\{listing_amount\}\}/g, listingAmount)
    .replace(/\{\{listing_price\}\}/g, listingAmount)
    .replace(/\{\{days_on_market\}\}/g, daysOnMarket)
    .replace(/\{\{deadline\}\}/g, deadlineLabel || "")
    .replace(/\{\{dynamic_page_url\}\}/g, dynamicUrl)
    .replace(/\{\{instant_login_url\}\}/g, instantLoginUrl || dynamicUrl)
    .replace(/\{\{unsubscribe_url\}\}/g, unsubUrl));
}

// Wrap links through track-click ONLY when click tracking is on (off keeps links clean
// and human). The open pixel is NOT added here anymore — the send worker adds it, so it
// works in plain-text mode too.
function injectOutreachTracking(html: string, _queueItemId: string, _token: string, _trackClicks: boolean): string {
  // No-op: the send worker (process-email-queue Netlify function) injects BOTH
  // click wrapping and the open pixel at send time, using this site's /t/* routes.
  // Doing it here too would double-wrap and point at a dead URL.
  return html;
}

export interface OutreachCampaignRow {
  id: string;
  subject: string;
  body_html: string;
  sender_account_id: string | null;
  sender_group_id?: string | null;
  contact_ids?: string[] | null;
  contact_emails?: string[] | null;
  audience_id?: string | null;
  // Send settings, carried from the template the campaign was composed from.
  email_format?: string | null;
  track_opens?: boolean | null;
  track_clicks?: boolean | null;
  include_unsubscribe?: boolean | null;
  tracking_image_url?: string | null;
  template_id?: string | null;
}

/**
 * Spread N recipients across a group's mailboxes with DOMAIN DIVERSITY: consecutive sends
 * hop from one domain to the next (round-robin over the group's domains), and within a
 * domain rotate across its mailboxes. With 6 domains x 3 mailboxes this returns to a
 * domain only every ~6 sends, on a different mailbox, which is gentler on each domain's
 * reputation than hammering the emptiest mailbox. Each mailbox still takes at most its
 * remaining daily cap; anything past the group's total remaining capacity is scheduled for
 * the next UTC midnight (when caps reset). Returns one plan entry per recipient, in order.
 */
async function planGroupRotation(
  groupId: string,
  count: number,
): Promise<{ senderId: string; scheduledFor: string }[] | null> {
  const { data: members } = await supabase
    .from("email_sender_accounts")
    .select("id,from_email,daily_limit,is_active")
    .eq("group_id", groupId);
  const active = ((members as { id: string; from_email: string; daily_limit: number | null; is_active: boolean | null }[]) || [])
    .filter((m) => m.is_active !== false);
  if (active.length === 0) return null;

  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  // Count everything queued today (pending + sending + sent), not just sent, so a second
  // compose send the same day sees the first one's still-pending rows and keeps the load
  // even instead of piling onto the same mailboxes.
  const { data: queuedToday } = await supabase
    .from("email_queue")
    .select("sender_account_id")
    .in("status", ["pending", "sending", "sent"])
    .gte("created_at", midnight.toISOString())
    .in("sender_account_id", active.map((m) => m.id))
    .limit(20000);
  const used: Record<string, number> = {};
  for (const r of (queuedToday as { sender_account_id: string | null }[]) || []) {
    if (r.sender_account_id) used[r.sender_account_id] = (used[r.sender_account_id] || 0) + 1;
  }

  const nextReset = new Date();
  nextReset.setUTCHours(24, 0, 0, 0);
  const nowIso = new Date().toISOString();
  const tomorrowIso = nextReset.toISOString();

  const domainOf = (e: string) => (e?.split("@")[1] || "").toLowerCase();
  // Mailboxes grouped by domain, each with remaining room today. Stable order so the
  // rotation is deterministic.
  const domains = [...new Set(active.map((m) => domainOf(m.from_email)))].sort();
  const byDomain = new Map<string, { id: string; left: number }[]>();
  for (const d of domains) {
    byDomain.set(d, active.filter((m) => domainOf(m.from_email) === d)
      .map((m) => ({ id: m.id, left: Math.max(0, (m.daily_limit ?? 50) - (used[m.id] || 0)) })));
  }
  const mboxIdx = new Map<string, number>(domains.map((d) => [d, 0])); // rotate within a domain

  // Next mailbox in a domain that still has room today, advancing that domain's cursor.
  const takeFromDomain = (d: string): { id: string; left: number } | null => {
    const list = byDomain.get(d)!;
    for (let k = 0; k < list.length; k++) {
      const idx = (mboxIdx.get(d)! + k) % list.length;
      if (list[idx].left > 0) { mboxIdx.set(d, idx + 1); return list[idx]; }
    }
    return null;
  };

  const plan: { senderId: string; scheduledFor: string }[] = [];
  let dCursor = 0;
  let todayFull = false;
  for (let i = 0; i < count; i++) {
    if (!todayFull) {
      let picked: { id: string; left: number } | null = null;
      // Walk domains starting at the cursor until one has room today.
      for (let k = 0; k < domains.length; k++) {
        const d = domains[(dCursor + k) % domains.length];
        const cand = takeFromDomain(d);
        if (cand) { cand.left -= 1; dCursor = dCursor + k + 1; picked = cand; break; }
      }
      if (picked) { plan.push({ senderId: picked.id, scheduledFor: nowIso }); continue; }
      todayFull = true; // no domain has room; the rest wait for the reset
    }
    // Overflow → tomorrow. Caps reset then, so distribute freely, still domain-rotated.
    const d = domains[dCursor % domains.length]; dCursor++;
    const list = byDomain.get(d)!;
    const mi = mboxIdx.get(d)! % list.length; mboxIdx.set(d, mi + 1);
    plan.push({ senderId: list[mi].id, scheduledFor: tomorrowIso });
  }
  return plan;
}

// Expand a saved outreach_campaigns row into queued emails and kick the worker.
// Returns how many recipients were queued.
export async function queueOutreachCampaign(campaign: OutreachCampaignRow): Promise<{ queued: number; heldForTomorrow: number }> {
  // 1. Resolve recipients (mirrors send-outreach's recipient query).
  let recipients: Record<string, unknown>[] = [];
  if (campaign.contact_ids && campaign.contact_ids.length > 0) {
    const { data } = await supabase.from("outreach_contacts").select("*")
      .in("id", campaign.contact_ids)
      .not("status", "eq", "unsubscribed").not("status", "eq", "rejected");
    recipients = (data as Record<string, unknown>[]) || [];
  } else if (campaign.contact_emails && campaign.contact_emails.length > 0) {
    // Manual email mode: reuse existing contacts, create minimal rows for new ones.
    const emailList = campaign.contact_emails;
    const { data: existing } = await supabase.from("outreach_contacts").select("*").in("email", emailList);
    const existingEmails = new Set(((existing as { email: string }[]) || []).map((c) => c.email));
    const newEmails = emailList.filter((e) => !existingEmails.has(e));
    if (newEmails.length > 0) {
      await supabase.from("outreach_contacts").insert(
        newEmails.map((email) => ({ name: email, email, status: "new", source: "manual_compose" })),
      );
    }
    const { data } = await supabase.from("outreach_contacts").select("*").in("email", emailList);
    recipients = (data as Record<string, unknown>[]) || [];
  } else if (campaign.audience_id) {
    const { data } = await supabase.from("outreach_contacts").select("*")
      .eq("audience_id", campaign.audience_id)
      .not("status", "eq", "unsubscribed").not("status", "eq", "rejected");
    recipients = (data as Record<string, unknown>[]) || [];
  }

  // 2. Drop globally-unsubscribed addresses.
  const { data: unsubs } = await supabase.from("outreach_unsubscribes").select("email");
  const unsubEmails = new Set(((unsubs as { email: string }[]) || []).map((u) => u.email));
  recipients = recipients.filter((c) => !unsubEmails.has(String(c.email)));

  if (recipients.length === 0) {
    await supabase.from("outreach_campaigns")
      .update({ status: "sent", total_recipients: 0, sent_at: new Date().toISOString() })
      .eq("id", campaign.id);
    return { queued: 0, heldForTomorrow: 0 };
  }

  const tpl = `${campaign.body_html || ""} ${campaign.subject || ""}`;
  const hasDynamicVar = tpl.includes("{{dynamic_page_url}}");
  const hasInstantVar = tpl.includes("{{instant_login_url}}");
  const needsDynamicPage = hasDynamicVar || hasInstantVar;

  const CHUNK = 200;
  const nowIso = new Date().toISOString();
  let totalQueued = 0;

  // Sending from a group means rotating: each recipient gets the next mailbox that still
  // has room today. One mailbox picked directly means every recipient gets that one.
  const rotation = campaign.sender_group_id
    ? await planGroupRotation(campaign.sender_group_id, recipients.length)
    : null;
  if (campaign.sender_group_id && !rotation) {
    throw new Error("That sender group has no active mailboxes. Add one, or un-pause a mailbox in Senders.");
  }
  const heldForTomorrow = rotation ? rotation.filter((p) => p.scheduledFor !== nowIso).length : 0;

  // From-name per sender, so each recipient's persona tags fill from the mailbox that
  // actually sends theirs (the rotated one, or the single chosen sender).
  const identById = new Map<string, { name?: string; email?: string }>();
  {
    const ids = new Set<string>();
    if (campaign.sender_account_id) ids.add(campaign.sender_account_id);
    for (const p of rotation || []) ids.add(p.senderId);
    if (ids.size > 0) {
      const { data: srows } = await supabase.from("email_sender_accounts")
        .select("id,from_name,from_email").in("id", [...ids]);
      for (const s of (srows as { id: string; from_name: string | null; from_email: string | null }[]) || []) {
        identById.set(s.id, { name: s.from_name || undefined, email: s.from_email || undefined });
      }
    }
  }

  for (let i = 0; i < recipients.length; i += CHUNK) {
    const chunk = recipients.slice(i, i + CHUNK);

    // Freeze the free-staging window at send time (email {{deadline}} + the page
    // countdown read from the same value, so they can never disagree).
    const freeUntilDate = new Date(Date.now() + FREE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const freeUntilIso = freeUntilDate.toISOString();
    const freeUntilLabel = freeUntilDate.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

    // Provision one dynamic landing page per recipient when the copy links to it.
    let dynamicPagesByContact: Record<string, string> = {};
    if (needsDynamicPage) {
      const pageInserts = chunk.map((contact) => ({
        contact_id: contact.id as string,
        campaign_id: campaign.id,
        recipient_email: contact.email as string,
        snapshot: {
          email: contact.email, street_address: contact.street_address, city: contact.city,
          state: contact.property_state, zip: contact.property_zip,
          bedrooms: contact.property_bedrooms, bathrooms: contact.property_bathrooms,
          square_feet: contact.property_square_feet, year_built: contact.property_year_built,
          property_type: contact.property_type, listing_amount: contact.listing_amount,
          days_on_market: contact.days_on_market, agent_name: contact.agent_name,
          listing_image_urls: contact.listing_image_urls,
          free_until: freeUntilIso, free_until_label: freeUntilLabel,
        },
      }));
      const { data: insertedPages } = await supabase
        .from("outreach_dynamic_pages").insert(pageInserts as any).select("contact_id, token");
      if (insertedPages) {
        dynamicPagesByContact = Object.fromEntries(
          (insertedPages as { contact_id: string; token: string }[]).map((p) => [p.contact_id, p.token]),
        );
      }
    }

    // Instant-login: a magic token per recipient, tied to the dynamic page.
    let instantUrlByContact: Record<string, string> = {};
    if (hasInstantVar) {
      const magicRows = chunk
        .map((contact) => {
          const dpt = dynamicPagesByContact[contact.id as string];
          if (!dpt) return null;
          return {
            id: crypto.randomUUID(),
            campaign_id: null, user_id: null,
            email: contact.email as string,
            destination_url: "/projects",
            flow_kind: "re_agent_instant",
            dynamic_page_token: dpt,
            expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (magicRows.length > 0) {
        await supabase.from("campaign_magic_tokens").insert(magicRows);
        instantUrlByContact = Object.fromEntries(
          magicRows.map((r) => [chunk.find((c) => (c.email as string) === r.email)?.id as string, `${PUBLIC_APP_URL}/auth/magic?token=${r.id}`]),
        );
      }
    }

    // Build queue rows. queueId is generated here so tracking is baked in before
    // insert (no second update pass, unlike the edge function).
    const rows = chunk.map((contact, j) => {
      const slot = rotation?.[i + j];
      const queueId = crypto.randomUUID();
      const token = crypto.randomUUID();
      const dynamicToken = dynamicPagesByContact[contact.id as string];
      const instantUrl = instantUrlByContact[contact.id as string];
      const senderAccountId = slot?.senderId ?? campaign.sender_account_id;
      const ident = senderAccountId ? identById.get(senderAccountId) : undefined;
      const subject = applySenderTags(
        substituteOutreachVars(campaign.subject, contact, campaign.id, dynamicToken, instantUrl, freeUntilLabel),
        ident?.name, ident?.email);
      const body = applySenderTags(
        substituteOutreachVars(campaign.body_html, contact, campaign.id, dynamicToken, instantUrl, freeUntilLabel),
        ident?.name, ident?.email);
      return {
        id: queueId,
        queue_type: "outreach",
        outreach_campaign_id: campaign.id,
        outreach_contact_id: contact.id as string,
        recipient_email: contact.email as string,
        recipient_name: (contact.name as string) || null,
        subject,
        html_body: injectOutreachTracking(body, queueId, token, campaign.track_clicks === true),
        tracking_token: token,
        status: "pending",
        scheduled_for: slot?.scheduledFor ?? nowIso,
        sender_account_id: senderAccountId,
        email_format: campaign.email_format || "html",
        track_opens: campaign.track_opens !== false,
        include_unsubscribe: campaign.include_unsubscribe === true,
        tracking_image_url: campaign.tracking_image_url || null,
        template_id: campaign.template_id || null,
      };
    });

    const { error: insErr } = await supabase.from("email_queue").insert(rows);
    if (insErr) throw new Error(insErr.message);
    totalQueued += rows.length;
  }

  // Kick the worker so the first batch goes out now; cron drains the rest.
  supabase.functions.invoke("process-email-queue", { body: {} }).catch(() => { /* cron will catch it */ });

  // Mark the campaign as sending and stamp the recipients as contacted.
  await supabase.from("outreach_campaigns")
    .update({ status: "sending", total_recipients: recipients.length, sent_at: nowIso })
    .eq("id", campaign.id);
  await supabase.from("outreach_contacts")
    .update({ last_contacted_at: nowIso, status: "contacted" })
    .in("id", recipients.map((r) => r.id as string));

  return { queued: totalQueued, heldForTomorrow };
}
