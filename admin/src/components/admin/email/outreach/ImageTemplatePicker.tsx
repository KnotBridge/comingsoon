import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Loader2, Upload, Image as ImageIcon, Trash2, Eye, AlertTriangle, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { CORE_TAGS, SENDER_TAGS } from "./mergeValues";

// Personalised image: a Photoshop file whose TEXT layers become merge tags, so
// every recipient gets their own rendered PNG (their name on the mockup).
//
// Rendering happens in the LOCAL mailer (npm run local) — Photoshop files need a
// real rasteriser — so this panel talks to /api/image-templates/* and says plainly
// when that isn't running instead of failing silently.

export interface ImageLayer {
  id: string;
  name: string;
  sampleText: string;
  suggestedTag: string | null;
  font: string;
  resolvedFont: string | null;
  fontAvailable: boolean;
  fontSize: number;
  color: string;
  align: string;
}

export interface ImageTemplate {
  id: string;
  name: string;
  width: number | null;
  height: number | null;
  layers: ImageLayer[];
  mapping: Record<string, string>;
  preview_url: string | null;
}

const TAG_OPTIONS = [...CORE_TAGS, ...SENDER_TAGS].filter((t) => t.tag !== "unsubscribe_url");

interface Props {
  value: string | null;                 // image_template_id on the email template
  onChange: (id: string | null) => void;
  onInsertTag?: () => void;             // drop {{dynamic_image}} into the body
  /** The email body + format, so the checklist can tell you what's still missing. */
  body?: string;
  emailFormat?: string;
  /** Bubble the sample render up so the email preview can show it. */
  onPreviewUrl?: (url: string | null) => void;
}

export default function ImageTemplatePicker({ value, onChange, onInsertTag, body = "", onPreviewUrl }: Props) {
  const [templates, setTemplates] = useState<ImageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [savingMap, setSavingMap] = useState(false);
  const [rendererUp, setRendererUp] = useState<boolean | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const picked = templates.find((t) => t.id === value) || null;

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("image_templates" as never)
      .select("id,name,width,height,layers,mapping,preview_url")
      .order("created_at", { ascending: false });
    // The migration for this feature is optional — say so rather than erroring.
    if (error && /does not exist|schema cache/i.test(error.message)) setSetupNeeded(true);
    setTemplates((data as unknown as ImageTemplate[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Share the sample render with the parent so the email preview shows the image.
  useEffect(() => { onPreviewUrl?.(picked?.preview_url ?? null); }, [picked?.preview_url, onPreviewUrl]);

  // Is the local renderer reachable?
  useEffect(() => {
    let dead = false;
    fetch("/api/image-templates/health")
      .then((r) => { if (!dead) setRendererUp(r.ok); })
      .catch(() => { if (!dead) setRendererUp(false); });
    return () => { dead = true; };
  }, []);

  const upload = async (file: File) => {
    if (!/\.psd$/i.test(file.name)) { toast.error("Pick a .psd file"); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("name", file.name.replace(/\.psd$/i, ""));
      const res = await fetch("/api/image-templates/scan", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Upload failed (${res.status})`);
      toast.success(`Found ${body.layers?.length ?? 0} editable text layer(s)`);
      await load();
      onChange(body.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const setLayerTag = async (layerId: string, tag: string) => {
    if (!picked) return;
    const mapping = { ...(picked.mapping || {}) };
    if (tag) mapping[layerId] = tag; else delete mapping[layerId];
    setTemplates((prev) => prev.map((t) => (t.id === picked.id ? { ...t, mapping } : t)));
    setSavingMap(true);
    const { error } = await supabase.from("image_templates" as never).update({ mapping } as never).eq("id", picked.id);
    setSavingMap(false);
    if (error) toast.error(error.message);
  };

  const preview = async () => {
    if (!picked) return;
    setPreviewing(true);
    try {
      // Realistic sample values, so the fit of a real name is obvious.
      const sample: Record<string, string> = {
        business_name: "Glow Med Spa", name: "Glow Med Spa", first_name: "Glow",
        category: "Medical spa", city: "Austin", state: "TX",
        address: "1420 Maple Ave", zip: "78704",
        website: "glowmedspa.com", phone: "(512) 555-0142",
        rating: "4.8", review_count: "212", email: "hello@glowmedspa.com",
        maps_url: "https://maps.google.com/",
        sender_name: "Justin H.", sender_first_name: "Justin", sender_email: "justin@rnq.agency",
      };
      const values: Record<string, string> = {};
      for (const [layerId, tag] of Object.entries(picked.mapping || {})) {
        if (tag) values[layerId] = sample[tag] ?? tag;
      }
      const res = await fetch("/api/image-templates/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: picked.id, values }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Preview failed");
      // Cache-bust so a re-render actually shows.
      setTemplates((prev) => prev.map((t) => (t.id === picked.id ? { ...t, preview_url: `${body.url}?t=${Date.now()}` } : t)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  };

  if (setupNeeded) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
        <p className="font-medium flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> Personalised images aren&apos;t set up yet
        </p>
        <p className="mt-1">
          Run <code className="bg-amber-100 px-1 rounded">supabase/migrations/002_dynamic_images.sql</code> in the Supabase SQL editor, then reload.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <ImageIcon className="w-3.5 h-3.5" /> Personalised image
          <span className="font-normal text-muted-foreground">— a PSD rendered per recipient</span>
        </p>
        <div className="flex items-center gap-1.5">
          <input ref={fileRef} type="file" accept=".psd" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1.5"
            disabled={uploading || rendererUp === false}
            onClick={() => fileRef.current?.click()}>
            {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
            {uploading ? "Scanning…" : "Upload PSD"}
          </Button>
        </div>
      </div>

      {rendererUp === false && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>
            The local renderer isn&apos;t running. Start it with <code className="bg-amber-100 px-1 rounded">npm run local</code> in the R&apos;NQ folder to upload or preview a PSD.
          </span>
        </p>
      )}

      {!loading && templates.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={value || ""}
            onChange={(e) => onChange(e.target.value || null)}
            className="h-7 flex-1 text-xs border border-input rounded-md px-2 bg-background"
          >
            <option value="">None — plain email</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.width}×{t.height})</option>
            ))}
          </select>
          {picked && (
            <Button type="button" size="sm" variant="ghost"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              title="Detach from this template" onClick={() => onChange(null)}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      )}

      {picked && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">
              Map each text layer to what it should say{savingMap && " · saving…"}
            </p>
            <div className="flex items-center gap-1.5">
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1.5"
                disabled={previewing || rendererUp === false} onClick={preview}>
                {previewing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
                Preview
              </Button>
              {onInsertTag && (
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={onInsertTag}>
                  Insert into body
                </Button>
              )}
            </div>
          </div>

          {(picked.layers || []).length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              No editable text layers in this file. Keep the placeholder text as real Photoshop text layers (not rasterised).
            </p>
          )}

          {(picked.layers || []).map((l) => (
            <div key={l.id} className="flex items-center gap-2 rounded-md border border-border/50 bg-background px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-foreground truncate">{l.name}</p>
                <p className="text-[10px] text-muted-foreground truncate">
                  &ldquo;{l.sampleText}&rdquo; · {l.fontSize}px
                  {l.fontAvailable
                    ? <span className="text-emerald-600"> · {l.resolvedFont}</span>
                    : <span className="text-amber-600" title="Install this font, or drop the .otf/.ttf into tools/render/fonts"> · {l.font} not installed</span>}
                </p>
              </div>
              <span className="w-3.5 h-3.5 rounded-sm border border-border/60 shrink-0"
                style={{ background: l.color }} title={l.color} />
              <select
                value={picked.mapping?.[l.id] || ""}
                onChange={(e) => setLayerTag(l.id, e.target.value)}
                className={cn(
                  "h-7 w-44 text-xs border rounded-md px-1.5 bg-background shrink-0",
                  picked.mapping?.[l.id] ? "border-primary/40 text-foreground" : "border-input text-muted-foreground",
                )}
              >
                <option value="">Leave as-is</option>
                {TAG_OPTIONS.map((t) => (
                  <option key={t.tag} value={t.tag}>{t.desc}</option>
                ))}
              </select>
            </div>
          ))}

          {picked.preview_url && (
            <div className="rounded-md border border-border/50 overflow-hidden bg-white">
              <img src={picked.preview_url} alt="preview" className="w-full h-auto block" />
            </div>
          )}

          <Checklist
            picked={picked}
            body={body}
            rendererUp={rendererUp}
            onInsertTag={onInsertTag}
          />
        </div>
      )}
    </div>
  );
}

// Everything that has to be true for a personalised image to actually arrive.
// Each failing row says what to do about it, so a send never silently produces
// an email with no picture.
function Checklist({
  picked, body, rendererUp, onInsertTag,
}: {
  picked: ImageTemplate;
  body: string;
  rendererUp: boolean | null;
  onInsertTag?: () => void;
}) {
  const layers = picked.layers || [];
  const mapped = layers.filter((l) => picked.mapping?.[l.id]);
  const missingFonts = layers.filter((l) => !l.fontAvailable);
  const hasTag = /\{\{\s*(tracked_image|dynamic_image)(?::\d+)?\s*\}\}/i.test(body);

  const rows: { ok: boolean; label: string; hint?: string; action?: { label: string; run: () => void } }[] = [
    {
      ok: rendererUp === true,
      label: "Local renderer running",
      hint: "Images are drawn on your machine — run `npm run local` in the R'NQ folder.",
    },
    {
      ok: layers.length > 0 && mapped.length === layers.length,
      label: `Every layer mapped (${mapped.length}/${layers.length})`,
      hint: "Pick what each text layer should say, above.",
    },
    {
      ok: hasTag,
      label: "Image tag in the email body",
      hint: "The body needs {{tracked_image}} where the picture goes. Works in plain text too.",
      action: onInsertTag && !hasTag ? { label: "Insert it", run: onInsertTag } : undefined,
    },
    {
      ok: missingFonts.length === 0,
      label: "Fonts installed",
      hint: missingFonts.length
        ? `Missing: ${missingFonts.map((l) => l.font).join(", ")}. Install it, or drop the .otf/.ttf into tools/render/fonts.`
        : undefined,
    },
    {
      ok: !!picked.preview_url,
      label: "Sample rendered",
      hint: "Press Preview to confirm the artwork looks right before sending.",
    },
  ];

  const failing = rows.filter((r) => !r.ok);

  return (
    <div className="rounded-md border border-border/60 bg-background px-2.5 py-2 space-y-1">
      <p className="text-[11px] font-medium text-foreground">
        {failing.length === 0
          ? "Ready to send — every recipient will get their own image."
          : `${failing.length} thing${failing.length === 1 ? "" : "s"} to fix before this image will arrive`}
      </p>
      {rows.map((r) => (
        <div key={r.label} className="flex items-start gap-1.5 text-[11px]">
          {r.ok
            ? <Check className="w-3 h-3 mt-0.5 text-emerald-600 shrink-0" />
            : <AlertTriangle className="w-3 h-3 mt-0.5 text-amber-600 shrink-0" />}
          <span className={cn("flex-1", r.ok ? "text-muted-foreground" : "text-foreground")}>
            {r.label}
            {!r.ok && r.hint && <span className="block text-muted-foreground">{r.hint}</span>}
          </span>
          {!r.ok && r.action && (
            <button type="button" onClick={r.action.run}
              className="text-[10px] text-primary underline shrink-0">{r.action.label}</button>
          )}
        </div>
      ))}
    </div>
  );
}
