import { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { Loader2, RefreshCw, BarChart3 } from "lucide-react";

// Per-template performance across BOTH flows and campaigns: how many sends each template
// drove and how many replies it earned (a replied thread is credited to the template of
// its LAST outbound). Filter by a pipeline status tag to see which templates pull the
// leads you actually care about.

interface Tag { id: string; label: string; color: string }
interface Row { template_id: string; template_name: string; sends: number; replies: number }
type SortKey = "rate" | "replies" | "sends";

export default function TemplatePerformancePage() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagId, setTagId] = useState<string>(""); // "" = all
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortKey>("rate");
  const [minSends, setMinSends] = useState(50); // hide tiny-volume noise by default

  useEffect(() => {
    supabase.from("outreach_tags" as any).select("id,label,color").order("created_at")
      .then(({ data }) => setTags((data as unknown as Tag[]) || []));
  }, []);

  const load = useCallback(async (tag: string) => {
    setLoading(true);
    const { data, error } = await supabase.rpc("template_performance" as any, { p_tag: tag || null });
    if (error) { setRows([]); setLoading(false); return; }
    setRows(((data as Row[]) || []).map((r) => ({ ...r, sends: Number(r.sends), replies: Number(r.replies) })));
    setLoading(false);
  }, []);

  useEffect(() => { void load(tagId); }, [tagId, load]);

  const view = useMemo(() => {
    const rate = (r: Row) => (r.sends > 0 ? r.replies / r.sends : 0);
    // When filtering by tag, sends are tiny, so don't apply the min-sends floor.
    const floor = tagId ? 0 : minSends;
    const filtered = rows.filter((r) => r.sends >= floor || r.replies > 0);
    const sorted = [...filtered].sort((a, b) =>
      sort === "sends" ? b.sends - a.sends
      : sort === "replies" ? b.replies - a.replies
      : rate(b) - rate(a) || b.replies - a.replies);
    return sorted;
  }, [rows, sort, minSends, tagId]);

  const maxRate = useMemo(() => Math.max(0.0001, ...view.map((r) => (r.sends > 0 ? r.replies / r.sends : 0))), [view]);
  const totals = useMemo(() => view.reduce((a, r) => ({ sends: a.sends + r.sends, replies: a.replies + r.replies }), { sends: 0, replies: 0 }), [view]);

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2"><BarChart3 className="w-5 h-5 text-primary" />Template performance</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Replies each template earned across flows and campaigns. A reply is credited to the last template sent in that thread. Filter by a status tag to see which templates pull your best leads.</p>
        </div>
        <button onClick={() => load(tagId)} disabled={loading}
          className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 text-xs rounded-lg border border-border hover:bg-muted/60 disabled:opacity-50">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Refresh
        </button>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">Status tag</span>
          <select value={tagId} onChange={(e) => setTagId(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs">
            <option value="">All threads</option>
            {tags.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">Sort by</span>
          <div className="flex bg-muted/40 rounded-md p-0.5">
            {(["rate", "replies", "sends"] as SortKey[]).map((k) => (
              <button key={k} onClick={() => setSort(k)}
                className={cn("px-2 h-6 rounded transition-colors capitalize", sort === k ? "bg-background shadow-sm text-foreground font-medium" : "text-muted-foreground hover:text-foreground")}>
                {k === "rate" ? "reply rate" : k}
              </button>
            ))}
          </div>
        </div>
        {!tagId && (
          <label className="inline-flex items-center gap-1.5 text-muted-foreground">
            Min sends
            <input type="number" min={0} value={minSends} onChange={(e) => setMinSends(Math.max(0, Number(e.target.value) || 0))}
              className="h-8 w-16 rounded-md border border-border bg-background px-2 text-xs" />
          </label>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : view.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No template data{tagId ? " for this tag" : ""} yet.
        </div>
      ) : (
        <div className="rounded-xl border border-border/60 overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-2 text-[11px] font-medium text-muted-foreground bg-muted/30 border-b border-border/60">
            <span>Template</span><span className="text-right w-16">Sends</span><span className="text-right w-16">Replies</span><span className="text-right w-28">Reply rate</span>
          </div>
          {view.map((r) => {
            const rate = r.sends > 0 ? r.replies / r.sends : 0;
            return (
              <div key={r.template_id} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-2 text-xs items-center border-b border-border/40 last:border-0">
                <span className="truncate text-foreground" title={r.template_name}>{r.template_name}</span>
                <span className="text-right w-16 tabular-nums text-muted-foreground">{r.sends.toLocaleString()}</span>
                <span className="text-right w-16 tabular-nums font-medium text-foreground">{r.replies.toLocaleString()}</span>
                <span className="text-right w-28 inline-flex items-center justify-end gap-2">
                  <span className="h-1.5 rounded-full bg-muted overflow-hidden flex-1 max-w-[60px]">
                    <span className="block h-full bg-primary/70" style={{ width: `${Math.round((rate / maxRate) * 100)}%` }} />
                  </span>
                  <span className="tabular-nums text-foreground w-12">{(rate * 100).toFixed(2)}%</span>
                </span>
              </div>
            );
          })}
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-2 text-[11px] items-center bg-muted/20 border-t border-border/60">
            <span className="text-muted-foreground">{view.length} templates</span>
            <span className="text-right w-16 tabular-nums text-muted-foreground">{totals.sends.toLocaleString()}</span>
            <span className="text-right w-16 tabular-nums text-foreground font-medium">{totals.replies.toLocaleString()}</span>
            <span className="text-right w-28 tabular-nums text-muted-foreground">{totals.sends ? ((totals.replies / totals.sends) * 100).toFixed(2) : "0.00"}%</span>
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground/70">
        Cold-outreach reply rates are small by nature, compare templates against each other, not against 100%. Replies are attributed to the last template sent before the reply; historical flow sends were backfilled from each step's template, campaign attribution starts from now.
      </p>
    </div>
  );
}
