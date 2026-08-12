import { useState, useEffect, useRef, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { OutreachAudience, OutreachTemplate, SenderAccount, ComposePrefill, FollowUpSegment } from "./types";
import { Send, FileText, Save, X, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import HighlightedTextarea from "./HighlightedTextarea";
import { queueOutreachCampaign, type OutreachCampaignRow } from "./sendMail";
import { buildEmailPreviewSrcDoc } from "./emailPreview";
import { TARGET_DEFAULT, parseTarget, targetValue, type GroupLite } from "./senderTargets";

const VARIABLE_CHIPS = [
  { label: "{{name}}", desc: "Full name" },
  { label: "{{first_name}}", desc: "First name" },
  { label: "{{agent_first_name}}", desc: "Listing agent first name" },
  { label: "{{username}}", desc: "@username" },
  { label: "{{followers}}", desc: "Formatted follower count" },
  { label: "{{platform}}", desc: "Platform name" },
  { label: "{{bio_snippet}}", desc: "First 80 chars of bio" },
  { label: "{{street_address}}", desc: "Property street address" },
  { label: "{{city}}", desc: "Listing city" },
  { label: "{{state}}", desc: "Listing state" },
  { label: "{{zip}}", desc: "Listing ZIP code" },
  { label: "{{property_type}}", desc: "e.g. Single family, Condo" },
  { label: "{{bedrooms}}", desc: "Bedroom count" },
  { label: "{{bathrooms}}", desc: "Bathroom count" },
  { label: "{{sqft}}", desc: "Square footage (formatted)" },
  { label: "{{year_built}}", desc: "Year property was built" },
  { label: "{{listing_amount}}", desc: "List price (formatted as $)" },
  { label: "{{days_on_market}}", desc: "Days listed on market" },
  { label: "{{dynamic_page_url}}", desc: "Personal listing landing page" },
  { label: "{{instant_login_url}}", desc: "One-click instant login link" },
  { label: "{{unsubscribe_url}}", desc: "Unsubscribe link" },
  // Filled at send time from the mailbox that actually sends, so one template signs
  // off with each sender's own name.
  { label: "{{sender_name}}", desc: "The sending persona's full name" },
  { label: "{{sender_first_name}}", desc: "The sending persona's first name" },
  { label: "{{sender_email}}", desc: "The sending mailbox's address" },
];

interface Props {
  audiences: OutreachAudience[];
  prefill?: ComposePrefill | null;
  onPrefillConsumed?: () => void;
}

const SEGMENT_LABEL: Record<FollowUpSegment, string> = {
  all: "All recipients",
  opened: "Openers",
  clicked: "Clickers",
};

type RecipientMode = "audience" | "manual";

function parseEmails(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map(e => e.trim().toLowerCase())
    .filter(e => e.includes("@"));
}

export default function ComposePage({ audiences, prefill, onPrefillConsumed }: Props) {
  const [senders, setSenders] = useState<SenderAccount[]>([]);
  const [templates, setTemplates] = useState<OutreachTemplate[]>([]);
  const [senderId, setSenderId] = useState<string | null>(null);
  const [senderGroups, setSenderGroups] = useState<GroupLite[]>([]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [recipientMode, setRecipientMode] = useState<RecipientMode>("audience");
  const [audienceId, setAudienceId] = useState("");
  const [manualEmails, setManualEmails] = useState("");
  const [recipientCount, setRecipientCount] = useState(0);
  const [trackReplies, setTrackReplies] = useState(false);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sampleContact, setSampleContact] = useState<Record<string, unknown> | null>(null);
  const [activeField, setActiveField] = useState<"subject" | "body">("body");
  const [showTemplateDropdown, setShowTemplateDropdown] = useState(false);
  const [showSaveTemplateModal, setShowSaveTemplateModal] = useState(false);
  const [templateName, setTemplateName] = useState("");
  // Send settings for this compose (inherited from a picked template).
  const [sendSettings, setSendSettings] = useState({ email_format: "html", track_opens: true, track_clicks: false, include_unsubscribe: false, tracking_image_url: "" });
  // The template this compose was built from, so per-template reply performance can attribute it.
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [lineage, setLineage] = useState<{ parentId: string; parentName: string; segment: FollowUpSegment } | null>(null);
  const subjectRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);


  useEffect(() => {
    (async () => {
      const [{ data: s }, { data: g }] = await Promise.all([
        supabase.from("email_sender_accounts").select("*"),
        supabase.from("sender_groups" as any).select("id,name,color,is_default").order("created_at"),
      ]);
      const list = (s as SenderAccount[]) || [];
      const groups = (g as unknown as GroupLite[]) || [];
      setSenders(list);
      setSenderGroups(groups);
      // Preselect whatever is marked default in Senders. A default group wins over a
      // default mailbox; only one of the two can be set at a time anyway.
      const defGroup = groups.find((x) => x.is_default);
      if (defGroup) { setGroupId(defGroup.id); setSenderId(null); return; }
      const def = list.find((x) => x.is_default);
      if (def) { setSenderId(def.id); setGroupId(null); }
    })();
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    const { data } = await supabase.from("outreach_templates").select("*").order("created_at", { ascending: false });
    setTemplates((data as OutreachTemplate[]) || []);
  };

  // Auto-populate from prefill (Contacts page or Sent Log follow-up)
  useEffect(() => {
    if (prefill && prefill.emails.length > 0) {
      setRecipientMode("manual");
      setManualEmails(prefill.emails.join("\n"));
      if (prefill.parentId && prefill.parentName && prefill.segment) {
        setLineage({ parentId: prefill.parentId, parentName: prefill.parentName, segment: prefill.segment });
        const truncated = prefill.parentName.length > 60 ? prefill.parentName.slice(0, 57) + "…" : prefill.parentName;
        setName(`Follow-up · ${SEGMENT_LABEL[prefill.segment]} · ${truncated}`);
      }
      onPrefillConsumed?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live count for audience mode
  useEffect(() => {
    if (recipientMode !== "audience") return;
    if (!audienceId) { setRecipientCount(0); return; }
    supabase.from("outreach_contacts").select("id", { count: "exact", head: true })
      .eq("audience_id", audienceId)
      .not("status", "eq", "unsubscribed")
      .not("status", "eq", "rejected")
      .then(({ count }) => setRecipientCount(count || 0));
  }, [audienceId, recipientMode]);

  // Live count for manual mode
  useEffect(() => {
    if (recipientMode !== "manual") return;
    setRecipientCount(parseEmails(manualEmails).length);
  }, [manualEmails, recipientMode]);

  const insertVar = (v: string) => {
    if (activeField === "subject" && subjectRef.current) {
      const el = subjectRef.current;
      const start = el.selectionStart || 0;
      const end = el.selectionEnd || 0;
      setSubject(subject.slice(0, start) + v + subject.slice(end));
      setTimeout(() => el.setSelectionRange(start + v.length, start + v.length), 0);
    } else if (activeField === "body" && bodyRef.current) {
      const el = bodyRef.current;
      const start = el.selectionStart || 0;
      const end = el.selectionEnd || 0;
      setBodyHtml(bodyHtml.slice(0, start) + v + bodyHtml.slice(end));
      setTimeout(() => el.setSelectionRange(start + v.length, start + v.length), 0);
    }
  };

  const applyTemplate = (t: OutreachTemplate) => {
    setSubject(t.subject);
    setBodyHtml(t.body_html);
    // Inherit the template's send settings so Compose sends it the way it was built.
    const tt = t as unknown as Record<string, unknown>;
    setSendSettings({
      email_format: (tt.email_format as string) || "html",
      track_opens: tt.track_opens !== false,
      track_clicks: tt.track_clicks === true,
      include_unsubscribe: tt.include_unsubscribe === true,
      tracking_image_url: (tt.tracking_image_url as string) || "",
    });
    setAppliedTemplateId(t.id);
    setShowTemplateDropdown(false);
    toast.success(`Template "${t.name}" loaded`);
  };

  const saveAsTemplate = async () => {
    if (!templateName.trim()) { toast.error("Enter a template name"); return; }
    if (!subject || !bodyHtml) { toast.error("Subject and body required"); return; }
    setSavingTemplate(true);
    const { error } = await supabase.from("outreach_templates").insert({
      name: templateName.trim(), subject, body_html: bodyHtml,
    });
    setSavingTemplate(false);
    if (error) { toast.error("Failed to save template"); return; }
    toast.success("Template saved");
    setTemplateName("");
    setShowSaveTemplateModal(false);
    loadTemplates();
  };

  // Live preview: fetch a representative sample contact whenever the recipient
  // selection changes, so {{placeholders}} render like a real, personalized email.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let sample: Record<string, unknown> | null = null;
      if (recipientMode === "audience" && audienceId) {
        const { data } = await supabase.from("outreach_contacts").select("*").eq("audience_id", audienceId).limit(1).maybeSingle();
        sample = (data as Record<string, unknown>) || null;
      } else if (recipientMode === "manual") {
        const emails = parseEmails(manualEmails);
        if (emails.length > 0) {
          const { data } = await supabase.from("outreach_contacts").select("*").eq("email", emails[0]).limit(1).maybeSingle();
          sample = (data as Record<string, unknown>) || { name: emails[0], email: emails[0] };
        }
      }
      if (!cancelled) setSampleContact(sample);
    })();
    return () => { cancelled = true; };
  }, [recipientMode, audienceId, manualEmails]);

  // Build the {{var}} -> value map from the sample contact (or a generic demo one).
  const subMap = useMemo<Record<string, string>>(() => {
    const sample = sampleContact || { name: "Alex Morgan", email: "alex@example.com", username: "alexmorgan", followers: 24000, platform: "instagram", bio: "Austin real estate, boutique listings.", street_address: "1420 Maple Ave", city: "Austin", property_state: "TX", property_zip: "78704", property_type: "Single family", property_bedrooms: 4, property_bathrooms: 3, property_square_feet: 2450, property_year_built: 2016, listing_amount: 729000, days_on_market: 12, agent_name: "Alex Morgan" };
    const fmtNum = (n: unknown) => {
      if (n == null || n === "") return "";
      const x = Number(n);
      return Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "";
    };
    const fmtMoney = (n: unknown) => { const s = fmtNum(n); return s ? "$" + s : ""; };
    return {
      name: String(sample.name || ""),
      first_name: String(sample.name || "").split(" ")[0],
      agent_first_name: String(sample.agent_name || sample.name || "").split(" ")[0],
      agent_name: String(sample.agent_name || ""),
      username: sample.username ? `@${sample.username}` : "",
      followers: sample.followers ? (Number(sample.followers) >= 1000 ? Math.round(Number(sample.followers) / 1000) + "k" : String(sample.followers)) : "",
      platform: String(sample.platform || ""),
      bio_snippet: String(sample.bio || "").substring(0, 80),
      street_address: String(sample.street_address || ""),
      property_address: String(sample.street_address || ""),
      listingCity: String(sample.city || ""),
      city: String(sample.city || ""),
      state: String(sample.property_state || ""),
      property_state: String(sample.property_state || ""),
      zip: String(sample.property_zip || ""),
      property_zip: String(sample.property_zip || ""),
      property_type: String(sample.property_type || ""),
      year_built: sample.property_year_built != null ? String(sample.property_year_built) : "",
      property_year_built: sample.property_year_built != null ? String(sample.property_year_built) : "",
      bedrooms: sample.property_bedrooms != null ? String(sample.property_bedrooms) : "",
      property_bedrooms: sample.property_bedrooms != null ? String(sample.property_bedrooms) : "",
      bathrooms: sample.property_bathrooms != null ? String(sample.property_bathrooms) : "",
      property_bathrooms: sample.property_bathrooms != null ? String(sample.property_bathrooms) : "",
      sqft: fmtNum(sample.property_square_feet),
      square_feet: fmtNum(sample.property_square_feet),
      property_square_feet: fmtNum(sample.property_square_feet),
      listing_amount: fmtMoney(sample.listing_amount),
      listing_price: fmtMoney(sample.listing_amount),
      days_on_market: sample.days_on_market != null ? String(sample.days_on_market) : "",
      dynamic_page_url: "#",
      instant_login_url: "#",
      unsubscribe_url: "#",
      // Preview the sender tags with the sender actually chosen in "From", so the
      // sign-off in the preview reads exactly as the recipient will get it.
      ...(() => {
        const s = groupId
          ? senders.find((x) => (x as { group_id?: string | null }).group_id === groupId && x.is_active !== false)
          : senders.find((x) => x.id === senderId);
        const full = (s?.from_name || "").trim();
        const parts = full.split(/\s+/).filter(Boolean);
        return {
          sender_name: full || "Your name",
          sender_full_name: full || "Your name",
          sender_first_name: parts[0] || "Your",
          sender_last_name: parts.slice(1).join(" "),
          sender_email: s?.from_email || "you@yourdomain.com",
        };
      })(),
    };
  }, [sampleContact, senders, senderId, groupId]);

  const applySub = (text: string) => (text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (subMap[k] != null && subMap[k] !== "" ? subMap[k] : `{{${k}}}`));
  const previewSubject = useMemo(() => applySub(subject), [subject, subMap]); // eslint-disable-line react-hooks/exhaustive-deps
  const previewDoc = useMemo(
    () => buildEmailPreviewSrcDoc({ body: bodyHtml, format: sendSettings.email_format, trackingImageUrl: sendSettings.tracking_image_url, fill: applySub }),
    [bodyHtml, subMap, sendSettings.email_format, sendSettings.tracking_image_url], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Debounce the srcDoc so the preview iframe doesn't reload on every keystroke.
  const [previewDocDebounced, setPreviewDocDebounced] = useState(previewDoc);
  useEffect(() => {
    const t = setTimeout(() => setPreviewDocDebounced(previewDoc), 180);
    return () => clearTimeout(t);
  }, [previewDoc]);

  const saveDraft = async () => {
    if (!name || !subject || !bodyHtml) { toast.error("Name, subject and body are required"); return; }
    setSaving(true);
    const { error } = await supabase.from("outreach_campaigns").insert({
      name, subject, body_html: bodyHtml,
      ...sendSettings,
      sender_account_id: senderId,
      sender_group_id: groupId,
      audience_id: recipientMode === "audience" ? (audienceId || null) : null,
      contact_emails: recipientMode === "manual" ? parseEmails(manualEmails) : null,
      track_replies: trackReplies,
      status: "draft",
      parent_campaign_id: lineage?.parentId ?? null,
      follow_up_segment: lineage?.segment ?? null,
    });
    setSaving(false);
    if (error) { toast.error("Failed to save draft"); return; }
    toast.success("Draft saved");
  };

  const sendNow = async () => {
    if (!name || !subject || !bodyHtml) { toast.error("Name, subject and body are required"); return; }
    if (recipientMode === "audience" && !audienceId) { toast.error("Select an audience"); return; }
    if (recipientMode === "manual" && parseEmails(manualEmails).length === 0) { toast.error("Enter at least one valid email"); return; }
    setSending(true);

    const emailList = recipientMode === "manual" ? parseEmails(manualEmails) : null;

    const { data: campaign, error: cErr } = await supabase.from("outreach_campaigns").insert({
      name, subject, body_html: bodyHtml,
      ...sendSettings,
      sender_account_id: senderId,
      sender_group_id: groupId,
      audience_id: recipientMode === "audience" ? (audienceId || null) : null,
      contact_emails: emailList,
      track_replies: trackReplies,
      status: "draft",
      parent_campaign_id: lineage?.parentId ?? null,
      follow_up_segment: lineage?.segment ?? null,
    }).select().single();

    if (cErr || !campaign) { toast.error("Failed to create campaign"); setSending(false); return; }

    // Expand + queue directly through the deployed worker (send-outreach is not
    // deployed on the platform; queueOutreachCampaign is a faithful port of it).
    try {
      const { queued, heldForTomorrow } = await queueOutreachCampaign({ ...(campaign as OutreachCampaignRow), template_id: appliedTemplateId });
      setSending(false);
      if (queued === 0) { toast.error("No eligible recipients (all unsubscribed or filtered out)"); return; }
      const via = groupId ? ` across ${senderGroups.find((g) => g.id === groupId)?.name ?? "the group"}` : "";
      toast.success(`Campaign queued for ${queued} contact${queued !== 1 ? "s" : ""}${via}`);
      if (heldForTomorrow > 0) {
        toast.info(`${heldForTomorrow} held for tomorrow — the group hit today's limit. They send automatically after the reset at UTC midnight.`);
      }
      setName(""); setSubject(""); setBodyHtml(""); setManualEmails(""); setLineage(null);
    } catch (e) {
      setSending(false);
      toast.error("Send failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* LEFT: controls (scrollable) + sticky action footer */}
      <div className="w-[460px] xl:w-[520px] shrink-0 flex flex-col min-h-0 border-r border-border bg-card">
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">
          {lineage && (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
              <div className="text-sm">
                <p className="font-medium text-foreground">
                  Follow-up to <span className="text-primary">{lineage.parentName}</span>
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {SEGMENT_LABEL[lineage.segment]} · {prefill?.emails.length ?? recipientCount} recipient{(prefill?.emails.length ?? recipientCount) !== 1 ? "s" : ""}
                </p>
              </div>
              <button
                onClick={() => setLineage(null)}
                className="text-muted-foreground hover:text-foreground"
                title="Remove lineage (campaign will be saved as standalone)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Campaign name */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Campaign name</label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Partner outreach, March 2026" className="text-sm" />
          </div>

          {/* Recipient selector */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Recipients</label>
            <div className="flex gap-2 mb-3 flex-wrap">
              {(["audience", "manual"] as const).map(m => (
                <button key={m} onClick={() => setRecipientMode(m)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${recipientMode === m ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
                  {m === "audience" ? "Full audience" : "Specific emails"}
                </button>
              ))}
            </div>
            {recipientMode === "audience" && (
              <div className="flex items-center gap-3">
                <select value={audienceId} onChange={e => setAudienceId(e.target.value)} className="flex-1 h-9 text-sm border border-input rounded-md px-3 bg-background">
                  <option value="">Select audience…</option>
                  {audiences.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                {audienceId && <span className="text-sm text-muted-foreground whitespace-nowrap">{recipientCount} eligible</span>}
              </div>
            )}
            {recipientMode === "manual" && (
              <div>
                <Textarea
                  value={manualEmails}
                  onChange={e => setManualEmails(e.target.value)}
                  placeholder={"Paste emails, one per line or comma-separated:\nalex@example.com\nmike@example.com, sarah@example.com"}
                  className="text-sm font-mono min-h-[100px] resize-y"
                />
                <p className="text-xs text-muted-foreground mt-1">{recipientCount} recipient{recipientCount !== 1 ? "s" : ""} detected</p>
              </div>
            )}
          </div>

          {/* From */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">From</label>
            <select
              value={targetValue(senderId, groupId)}
              onChange={e => { const t = parseTarget(e.target.value); setSenderId(t.senderId); setGroupId(t.groupId); }}
              className="w-full h-9 text-sm border border-input rounded-md px-3 bg-background"
            >
              <option value={TARGET_DEFAULT}>Default sender</option>
              {senderGroups.length > 0 && (
                <optgroup label="Groups — rotate across mailboxes">
                  {senderGroups.map(g => {
                    const n = senders.filter(s => (s as { group_id?: string | null }).group_id === g.id && s.is_active !== false).length;
                    return <option key={g.id} value={`group:${g.id}`}>{g.name} · {n} mailbox{n === 1 ? "" : "es"}{g.is_default ? " (default)" : ""}</option>;
                  })}
                </optgroup>
              )}
              <optgroup label="Single mailbox">
                {senders.map(s => (
                  <option key={s.id} value={`sender:${s.id}`}>
                    {s.from_name} &lt;{s.from_email}&gt;{s.is_default ? " (default)" : ""}{s.is_active === false ? " · paused" : ""}
                  </option>
                ))}
              </optgroup>
            </select>
            {groupId && (() => {
              const members = senders.filter(s => (s as { group_id?: string | null }).group_id === groupId);
              const active = members.filter(s => s.is_active !== false);
              return (
                <p className="text-[11px] text-muted-foreground mt-1">
                  {active.length === 0
                    ? "This group has no active mailboxes — sending will fail until you add or un-pause one."
                    : `Each recipient goes out from the emptiest of these ${active.length} mailbox${active.length === 1 ? "" : "es"}, up to each one's daily limit.`}
                </p>
              );
            })()}
          </div>

          {/* Subject */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Subject line</label>
            <HighlightedTextarea
              singleLine
              ref={subjectRef}
              value={subject}
              onChange={setSubject}
              onFocus={() => setActiveField("subject")}
              placeholder="Hey {{first_name}}, want to collaborate with Renov?"
            />
          </div>

          {/* Body with template controls */}
          <div>
            <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
              <label className="text-xs font-medium text-muted-foreground">Email body (HTML or plain text)</label>
              <div className="flex items-center gap-2">
                {/* Template dropdown */}
                <div className="relative">
                  <button
                    onClick={() => setShowTemplateDropdown(v => !v)}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-muted/60 transition-colors text-muted-foreground">
                    <FileText className="w-3 h-3" />
                    Use template
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {showTemplateDropdown && (
                    <div className="absolute right-0 top-full mt-1 z-20 bg-card border border-border rounded-lg shadow-lg min-w-[200px] max-h-64 overflow-y-auto py-1">
                      {templates.length === 0 ? (
                        <p className="text-xs text-muted-foreground px-3 py-2">No saved templates</p>
                      ) : templates.map(t => (
                        <button key={t.id} onClick={() => applyTemplate(t)}
                          className="w-full text-left text-xs px-3 py-2 hover:bg-muted/60 transition-colors text-foreground">
                          {t.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setShowSaveTemplateModal(true)}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-muted/60 transition-colors text-muted-foreground">
                  <Save className="w-3 h-3" />
                  Save
                </button>
              </div>
            </div>
            <HighlightedTextarea
              ref={bodyRef}
              value={bodyHtml}
              onChange={setBodyHtml}
              onFocus={() => setActiveField("body")}
              placeholder={"Hi {{first_name}},\n\nI came across your profile @{{username}} and was really impressed...\n\n{{unsubscribe_url}}"}
              rows={12}
            />
            {/* Variable chips — click to insert at the cursor of the focused field */}
            <div className="mt-2">
              <p className="text-[11px] text-muted-foreground mb-1.5">Insert variable ({activeField === "subject" ? "into subject" : "into body"})</p>
              <div className="flex flex-wrap gap-1.5">
                {VARIABLE_CHIPS.map(c => (
                  <button key={c.label} onClick={() => insertVar(c.label)} title={c.desc}
                    className="text-[11px] px-2 py-0.5 rounded bg-muted border border-border hover:bg-primary/10 hover:border-primary/30 font-mono transition-colors">
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Track replies */}
          <div className="flex items-start gap-2.5">
            <Checkbox id="track_replies" checked={trackReplies} onCheckedChange={v => setTrackReplies(!!v)} className="mt-0.5" />
            <label htmlFor="track_replies" className="text-sm text-foreground cursor-pointer">
              Track replies from this campaign
              <span className="block text-xs text-muted-foreground">Replied contacts appear in the Replies inbox</span>
            </label>
          </div>

        </div>

        {/* Sticky action footer */}
        <div className="shrink-0 border-t border-border p-4 flex items-center gap-3 bg-card">
          <Button onClick={sendNow} disabled={sending || recipientCount === 0} className="gap-2 flex-1">
            <Send className="w-4 h-4" />
            {sending ? "Queuing…" : `Send to ${recipientCount}`}
          </Button>
          <Button variant="outline" onClick={saveDraft} disabled={saving}>
            {saving ? "Saving…" : "Save draft"}
          </Button>
        </div>
      </div>

      {/* RIGHT: always-on live preview */}
      <div className="flex-1 min-w-0 flex flex-col bg-muted/20">
        <div className="shrink-0 px-5 py-3 border-b border-border flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">Live preview</span>
          <span className="text-xs text-muted-foreground">{sampleContact ? "personalized with a real contact" : "sample data"}</span>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden p-6 flex justify-center">
          <div className="w-full max-w-[680px] flex flex-col bg-white rounded-xl shadow-sm border border-border overflow-hidden">
            <div className="shrink-0 px-5 py-3 border-b border-border/60 bg-muted/20">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Subject</p>
              <p className="text-sm font-medium text-foreground mt-0.5 truncate">
                {previewSubject || <span className="text-muted-foreground font-normal">(no subject yet)</span>}
              </p>
            </div>
            {bodyHtml.trim() ? (
              <iframe
                title="Email preview"
                sandbox="allow-same-origin allow-popups"
                className="w-full flex-1 min-h-0 border-0 block"
                srcDoc={previewDocDebounced}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground p-8 text-center">
                Start writing the email body to see it here.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Save template modal */}
      {showSaveTemplateModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={() => setShowSaveTemplateModal(false)}>
          <div className="bg-card rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-foreground">Save as template</h3>
              <button onClick={() => setShowSaveTemplateModal(false)}><X className="w-4 h-4 text-muted-foreground" /></button>
            </div>
            <Input
              value={templateName}
              onChange={e => setTemplateName(e.target.value)}
              placeholder="Template name…"
              className="text-sm mb-3"
              onKeyDown={e => e.key === "Enter" && saveAsTemplate()}
            />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowSaveTemplateModal(false)}>Cancel</Button>
              <Button size="sm" onClick={saveAsTemplate} disabled={savingTemplate}>
                {savingTemplate ? "Saving…" : "Save template"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
