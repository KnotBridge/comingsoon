import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { OutreachTemplate } from "./types";
import { Plus, Pencil, Trash2, FileText, X, Save, Eye, Image as ImageIcon, Loader2 } from "lucide-react";
import HighlightedTextarea from "./HighlightedTextarea";
import RichEmailEditor from "./RichEmailEditor";
import { themeKeyOf } from "./emailThemes";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buildEmailPreviewSrcDoc, fillDemo } from "./emailPreview";
import { cn } from "@/lib/utils";

// The Media Library bucket/folder (shared with MediaLibraryTab). Tracking images are
// picked from here, but any external image URL works too.
const MEDIA_BUCKET = "landing-assets";
const MEDIA_FOLDER = "email-assets";

// Small popover that lists Media Library images and returns the one you click. Lazy-loads
// on first open so opening the template modal stays cheap.
function MediaPicker({ onPick }: { onPick: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<{ name: string; url: string }[]>([]);
  const loadOnce = async () => {
    if (items.length || loading) return;
    setLoading(true);
    const { data } = await supabase.storage.from(MEDIA_BUCKET).list(MEDIA_FOLDER, { limit: 200, sortBy: { column: "created_at", order: "desc" } });
    const imgs = (data || [])
      .filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name))
      .map((f) => ({ name: f.name, url: supabase.storage.from(MEDIA_BUCKET).getPublicUrl(`${MEDIA_FOLDER}/${f.name}`).data.publicUrl }));
    setItems(imgs);
    setLoading(false);
  };
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) void loadOnce(); }}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs shrink-0">
          <ImageIcon className="w-3.5 h-3.5" />Library
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        {loading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /></div>
        ) : items.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">No images in the Media Library yet. Upload some in the Media tab, or paste an external URL.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 max-h-64 overflow-y-auto">
            {items.map((it) => (
              <button key={it.name} type="button" title={it.name}
                onClick={() => { onPick(it.url); setOpen(false); }}
                className="aspect-square rounded-md border border-border/60 overflow-hidden hover:ring-2 hover:ring-primary">
                <img src={it.url} alt={it.name} className="w-full h-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<OutreachTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ open: boolean; editing: OutreachTemplate | null }>({ open: false, editing: null });
  const [preview, setPreview] = useState<OutreachTemplate | null>(null);
  const [form, setForm] = useState({ name: "", subject: "", body_html: "" });
  const [themeKey, setThemeKey] = useState("kingkong");
  // Send settings for this template — honored by flows, compose and replies.
  const [settings, setSettings] = useState({ email_format: "html", track_opens: true, track_clicks: false, include_unsubscribe: false, tracking_image_url: "" });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("outreach_templates").select("*").order("created_at", { ascending: false });
    setTemplates((data as OutreachTemplate[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setForm({ name: "", subject: "", body_html: "" });
    setThemeKey("kingkong");
    setSettings({ email_format: "html", track_opens: true, track_clicks: false, include_unsubscribe: false, tracking_image_url: "" });
    setModal({ open: true, editing: null });
  };

  const openEdit = (t: OutreachTemplate) => {
    setForm({ name: t.name, subject: t.subject, body_html: t.body_html });
    setThemeKey(themeKeyOf(t.body_html));
    const tt = t as unknown as Record<string, unknown>;
    setSettings({
      email_format: (tt.email_format as string) || "html",
      track_opens: tt.track_opens !== false,
      track_clicks: tt.track_clicks === true,
      include_unsubscribe: tt.include_unsubscribe === true,
      tracking_image_url: (tt.tracking_image_url as string) || "",
    });
    setModal({ open: true, editing: t });
  };

  const closeModal = () => setModal({ open: false, editing: null });

  const save = async () => {
    if (!form.name.trim() || !form.subject.trim() || !form.body_html.trim()) {
      toast.error("Name, subject and body are required");
      return;
    }
    setSaving(true);
    try {
      if (modal.editing) {
        const { error } = await supabase.from("outreach_templates").update({
          name: form.name, subject: form.subject, body_html: form.body_html,
          ...settings,
          updated_at: new Date().toISOString(),
        } as any).eq("id", modal.editing.id);
        if (error) throw error;
        toast.success("Template updated");
      } else {
        const { error } = await supabase.from("outreach_templates").insert({
          name: form.name, subject: form.subject, body_html: form.body_html, ...settings,
        } as any);
        if (error) throw error;
        toast.success("Template created");
      }
      closeModal();
      load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save template");
    } finally {
      setSaving(false);
    }
  };

  const deleteTemplate = async (id: string) => {
    if (!confirm("Delete this template?")) return;
    setDeletingId(id);
    const { error } = await supabase.from("outreach_templates").delete().eq("id", id);
    if (error) toast.error(error.message);
    else { toast.success("Deleted"); load(); }
    setDeletingId(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-foreground">Email templates</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Reusable subjects and body content for outreach campaigns</p>
        </div>
        <Button size="sm" onClick={openNew} className="gap-1.5 h-8 text-xs rounded-lg px-3">
          <Plus className="w-3.5 h-3.5" /> New template
        </Button>
      </div>

      {loading && <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>}

      {!loading && templates.length === 0 && (
        <div className="text-center py-16 border border-dashed border-border rounded-lg text-muted-foreground">
          <FileText className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium text-foreground">No templates yet</p>
          <p className="text-xs mt-1">Create reusable email templates to speed up your outreach</p>
          <Button size="sm" variant="outline" className="mt-4 gap-1.5 h-8 text-xs rounded-lg" onClick={openNew}>
            <Plus className="w-3.5 h-3.5" /> Create first template
          </Button>
        </div>
      )}

      {!loading && templates.length > 0 && (
        <div className="divide-y divide-border/50 border-t border-border/50">
          {templates.map(t => (
            <div key={t.id} className="flex items-start justify-between gap-3 py-4">
              <button
                type="button"
                onClick={() => setPreview(t)}
                className="flex items-start gap-3 min-w-0 flex-1 text-left group"
                title="Preview email"
              >
                <div className="w-8 h-8 rounded-lg bg-muted group-hover:bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors">
                  <FileText className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm text-foreground group-hover:text-primary transition-colors">{t.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">{t.subject}</p>
                  <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2 leading-relaxed">
                    {t.body_html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().substring(0, 140)}…
                  </p>
                </div>
              </button>
              <div className="flex items-center gap-1 flex-shrink-0">
                <p className="text-xs text-muted-foreground mr-2">
                  {new Date(t.created_at).toLocaleDateString()}
                </p>
                <button
                  onClick={() => setPreview(t)}
                  className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
                  title="Preview email"
                >
                  <Eye className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => openEdit(t)}
                  className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
                  title="Edit template"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => deleteTemplate(t.id)}
                  disabled={deletingId === t.id}
                  className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                  title="Delete template"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Preview modal — renders the email with sample data, scrolls inside the frame */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setPreview(null)}>
          <div className="bg-card border border-border rounded-xl shadow-lg w-full max-w-2xl flex flex-col h-[85vh]" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border/50">
              <div className="min-w-0">
                <h4 className="font-medium text-foreground text-sm truncate">{preview.name}</h4>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  <span className="font-medium">Subject:</span> {fillDemo(preview.subject) || "(no subject)"}
                </p>
              </div>
              <button
                onClick={() => setPreview(null)}
                className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden bg-white rounded-b-none">
              <iframe
                title="Email preview"
                sandbox="allow-same-origin allow-popups"
                className="w-full h-full border-0 block"
                srcDoc={buildEmailPreviewSrcDoc({ body: preview.body_html, format: preview.email_format, trackingImageUrl: preview.tracking_image_url })}
              />
            </div>
            <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border/50">
              <p className="text-[11px] text-muted-foreground">Preview only · sample data shown for placeholders</p>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-8 text-xs rounded-lg px-3 gap-1.5" onClick={() => { const t = preview; setPreview(null); openEdit(t); }}>
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </Button>
                <Button size="sm" className="h-8 text-xs rounded-lg px-3" onClick={() => setPreview(null)}>Close</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal */}
      {modal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-card border border-border rounded-xl shadow-lg w-full max-w-5xl flex flex-col max-h-[92vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
              <h4 className="font-medium text-foreground text-sm">
                {modal.editing ? "Edit template" : "New template"}
              </h4>
              <button
                onClick={closeModal}
                className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-col gap-4 p-5 overflow-y-auto flex-1 min-h-0">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Template Name</label>
                <input
                  className="w-full border border-input rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="e.g. Partnership Outreach v1"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Subject Line</label>
                <HighlightedTextarea
                  singleLine
                  placeholder="e.g. Collaboration opportunity with {{name}}"
                  value={form.subject}
                  onChange={v => setForm(f => ({ ...f, subject: v }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Email body
                </label>
                <p className="text-xs text-muted-foreground -mt-0.5 leading-relaxed">
                  Use: <code className="bg-muted px-1 rounded">{"{{first_name}}"}</code> <code className="bg-muted px-1 rounded">{"{{agent_first_name}}"}</code> <code className="bg-muted px-1 rounded">{"{{street_address}}"}</code> <code className="bg-muted px-1 rounded">{"{{city}}"}</code> <code className="bg-muted px-1 rounded">{"{{state}}"}</code> <code className="bg-muted px-1 rounded">{"{{bedrooms}}"}</code> <code className="bg-muted px-1 rounded">{"{{bathrooms}}"}</code> <code className="bg-muted px-1 rounded">{"{{sqft}}"}</code> <code className="bg-muted px-1 rounded">{"{{year_built}}"}</code> <code className="bg-muted px-1 rounded">{"{{listing_amount}}"}</code> <code className="bg-muted px-1 rounded">{"{{days_on_market}}"}</code> <code className="bg-muted px-1 rounded">{"{{dynamic_page_url}}"}</code> <code className="bg-muted px-1 rounded">{"{{instant_login_url}}"}</code>
                </p>
                <p className="text-xs text-muted-foreground -mt-0.5 leading-relaxed">
                  Sender tags (filled from whichever mailbox sends it, so one template signs off with each persona's own name):{" "}
                  <code className="bg-muted px-1 rounded">{"{{sender_name}}"}</code> <code className="bg-muted px-1 rounded">{"{{sender_first_name}}"}</code> <code className="bg-muted px-1 rounded">{"{{sender_email}}"}</code>
                </p>
                {/* Send settings — how this template goes out, honored everywhere. */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 mb-1">
                  <div className="inline-flex items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">Format</span>
                    <div className="flex bg-background rounded-md border border-border p-0.5">
                      {(["html", "plain"] as const).map((f) => (
                        <button key={f} type="button"
                          onClick={() => setSettings(s => ({ ...s, email_format: f }))}
                          className={cn("px-2 h-6 text-[11px] rounded transition-colors", settings.email_format === f ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:text-foreground")}>
                          {f === "html" ? "Rich (HTML)" : "Plain text"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {([
                    ["track_opens", "Track opens (pixel)"],
                    ["track_clicks", "Track link clicks"],
                    ["include_unsubscribe", "Unsubscribe link"],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none">
                      <input type="checkbox" className="rounded"
                        checked={settings[key] as boolean}
                        onChange={e => setSettings(s => ({ ...s, [key]: e.target.checked }))} />
                      <span className={settings[key] ? "text-foreground" : "text-muted-foreground"}>{label}</span>
                    </label>
                  ))}
                </div>
                {/* Tracking image — a real, visible image that doubles as the open beacon. */}
                {(
                  <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 mb-1 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground shrink-0">Tracking image</span>
                      <input
                        type="url"
                        value={settings.tracking_image_url}
                        onChange={(e) => setSettings(s => ({ ...s, tracking_image_url: e.target.value }))}
                        placeholder="Paste an image URL, or pick from your library"
                        className="flex-1 h-8 rounded-md border border-border bg-background px-2 text-xs min-w-0"
                      />
                      <MediaPicker onPick={(url) => setSettings(s => ({ ...s, tracking_image_url: url }))} />
                    </div>
                    {settings.tracking_image_url && (
                      <div className="flex items-center gap-2">
                        <img src={settings.tracking_image_url} alt="" className="h-10 rounded border border-border/60 object-cover" />
                        <button type="button" className="text-[11px] text-muted-foreground underline" onClick={() => setSettings(s => ({ ...s, tracking_image_url: "" }))}>Remove</button>
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      Put{" "}
                      <code className="bg-muted px-1 rounded cursor-pointer" title="Copy"
                        onClick={() => { navigator.clipboard?.writeText("{{tracked_image}}"); toast.success("Copied {{tracked_image}}"); }}>{"{{tracked_image}}"}</code>{" "}
      exactly where the image should appear. With <b>Track opens</b> on, it renders as a real picture the recipient sees and doubles as the open beacon (instead of the invisible 1x1 pixel). It defaults to 480px wide; write <code className="bg-muted px-1 rounded">{"{{tracked_image:320}}"}</code> to set a different max width in px. In <b>plain-text</b> mode the text stays plain and the image is placed at the tag's spot inside the small HTML part the tracker already adds. Any image URL works, including one hosted elsewhere. Leave this empty to keep the invisible pixel.
                    </p>
                  </div>
                )}
                <RichEmailEditor
                  value={form.body_html}
                  onChange={v => setForm(f => ({ ...f, body_html: v }))}
                  themeKey={themeKey}
                  onThemeKey={setThemeKey}
                  plain={settings.email_format === "plain"}
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border/50">
              <Button size="sm" variant="outline" className="h-8 text-xs rounded-lg px-3" onClick={closeModal}>
                Cancel
              </Button>
              <Button size="sm" className="h-8 text-xs rounded-lg px-3 gap-1.5" onClick={save} disabled={saving}>
                <Save className="w-3.5 h-3.5" />
                {saving ? "Saving…" : modal.editing ? "Save changes" : "Create template"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
