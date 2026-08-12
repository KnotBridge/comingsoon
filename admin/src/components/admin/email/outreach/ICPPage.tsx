import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { Loader2, RefreshCw, Target, Users, Download } from "lucide-react";

// ICP (Ideal Customer Profile) — aggregate the property patterns of the contacts who
// responded positively, so you can see what your best leads actually look like. Cohort =
// contacts carrying the chosen pipeline tags (default: Hot lead + Offer sent + Staging
// sent). Every stat is shown next to a sampled baseline of all contacts, so the CONTRAST
// tells you what distinguishes a responder from the base. Reads the curated columns now;
// richer fields surface as the enrichment pass fills property_data.

interface Tag { id: string; label: string; color: string }
type Row = Record<string, unknown>;

const DEFAULT_TAGS = ["hot lead", "offer sent", "staging sent"]; // by label, case-insensitive
const BASELINE_SAMPLE = 3000; // cap the contrast set so the page stays fast

// Curated columns we mine for the ICP (present on every contact; more arrive via enrichment).
const CURATED_COLS = "listing_amount,price_per_square_foot,property_square_feet,property_bedrooms,property_bathrooms,property_year_built,days_on_market,property_type,property_state,city,office_name";
// Extra identity/address columns the enrichment extension needs to look each property up,
// and that let the round-trip enrich import match back (email → mls id → address).
const COHORT_COLS = `${CURATED_COLS},email,name,agent_name,street_address,property_zip,mls_listing_id,property_data`;
// The input file the extension consumes: enough to find each property + match on return.
const EXPORT_FIELDS = ["email", "name", "agent_name", "street_address", "city", "property_state", "property_zip", "mls_listing_id", "days_on_market"] as const;

const NUMERIC: { key: string; label: string; money?: boolean; int?: boolean }[] = [
  { key: "listing_amount", label: "List price", money: true },
  { key: "price_per_square_foot", label: "Price / sqft", money: true },
  { key: "property_square_feet", label: "Square feet", int: true },
  { key: "property_bedrooms", label: "Bedrooms" },
  { key: "property_bathrooms", label: "Bathrooms" },
  { key: "property_year_built", label: "Year built", int: true },
  { key: "days_on_market", label: "Days on market", int: true },
];
const CATEGORICAL: { key: string; label: string }[] = [
  { key: "property_type", label: "Property type" },
  { key: "property_state", label: "State" },
  { key: "city", label: "City" },
  { key: "office_name", label: "Brokerage / office" },
];

// Fields that only exist inside the enriched property_data blob (from full PropStream).
const PD_NUMERIC: { key: string; label: string; money?: boolean; pct?: boolean }[] = [
  { key: "estimatedValue", label: "Est. value", money: true },
  { key: "marketValue", label: "Market value", money: true },
  { key: "estimatedEquity", label: "Est. equity", money: true },
  { key: "equityPercentage", label: "Equity %", pct: true },
  { key: "ltvRatio", label: "LTV", pct: true },
  { key: "mortgageBalance", label: "Mortgage bal.", money: true },
  { key: "lastSaleAmount", label: "Last sale", money: true },
  { key: "taxAmount", label: "Tax / yr", money: true },
];
const PD_BOOL: { key: string; label: string }[] = [
  { key: "ownerOccupied", label: "Owner-occupied" },
  { key: "distressed", label: "Distressed" },
  { key: "foreclosed", label: "Foreclosed" },
  { key: "cashBuyer", label: "Cash buyer" },
  { key: "highEquity", label: "High equity" },
  { key: "freeClear", label: "Free & clear" },
];

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function nums(rows: Row[], key: string): number[] {
  const out: number[] = [];
  for (const r of rows) { const v = r[key]; const n = typeof v === "number" ? v : v != null ? parseFloat(String(v)) : NaN; if (Number.isFinite(n)) out.push(n); }
  return out;
}
function topCounts(rows: Row[], key: string, n = 6): { value: string; count: number; pct: number }[] {
  const map = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const v = (r[key] ?? "").toString().trim();
    if (!v) continue;
    map.set(v, (map.get(v) || 0) + 1); total++;
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count, pct: total ? Math.round((count / total) * 100) : 0 }));
}
function fmt(n: number | null, money?: boolean, int?: boolean): string {
  if (n == null) return "—";
  if (money) return "$" + Math.round(n).toLocaleString();
  if (int) return Math.round(n).toLocaleString();
  return (Math.round(n * 10) / 10).toLocaleString();
}
// Ratios come through as a 0–1 fraction (ltvRatio 0.65) OR already a percent; normalize.
function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return Math.round(Math.abs(n) <= 1.5 ? n * 100 : n) + "%";
}
// Pull a property_data field across rows (only rows that have the blob + a non-empty value).
function pdRaw(rows: Row[], key: string): unknown[] {
  const out: unknown[] = [];
  for (const r of rows) {
    const pd = r.property_data as Record<string, unknown> | null | undefined;
    if (pd && typeof pd === "object") { const v = pd[key]; if (v != null && v !== "") out.push(v); }
  }
  return out;
}
function pdNums(rows: Row[], key: string): number[] {
  return pdRaw(rows, key).map((v) => (typeof v === "number" ? v : parseFloat(String(v)))).filter((n) => Number.isFinite(n));
}
function pdBoolShare(rows: Row[], key: string): { pct: number; n: number } | null {
  const vals = pdRaw(rows, key);
  if (!vals.length) return null;
  const t = vals.filter((v) => v === true || v === "true" || v === 1 || v === "1").length;
  return { pct: Math.round((t / vals.length) * 100), n: vals.length };
}

// Compose a plain-English profile from whatever the current cohort shows. Every clause is
// conditional, so it stays truthful as the data grows (or when a field has no values yet).
function icpSummary(cohort: Row[], enriched: Row[]): string {
  const n = cohort.length;
  if (!n) return "";
  const val = median(pdNums(enriched, "estimatedValue")) ?? median(nums(cohort, "listing_amount"));
  const topType = topCounts(cohort, "property_type", 1)[0];
  const owner = pdBoolShare(enriched, "ownerOccupied");
  const highEq = pdBoolShare(enriched, "highEquity");
  const eqPct = median(pdNums(enriched, "equityPercentage"));
  const ltv = median(pdNums(enriched, "ltvRatio"));
  const dom = median(nums(cohort, "days_on_market"));
  const states = topCounts(cohort, "property_state", 3).map((s) => s.value);

  let lead = `Your best leads (${n} contact${n === 1 ? "" : "s"}) are typically`;
  if (owner && owner.pct >= 60) lead += " owner-occupied";
  lead += topType ? ` ${topType.value.toLowerCase()} listings` : " listings";
  if (val != null) lead += ` around ${fmt(val, true)}`;
  const parts = [lead];
  if (eqPct != null || (highEq && highEq.pct >= 50)) {
    let e = eqPct != null ? `with ${fmtPct(eqPct)} equity` : "mostly high-equity";
    if (ltv != null) e += ` (LTV ${fmtPct(ltv)})`;
    parts.push(e);
  }
  if (dom != null) parts.push(`on the market ~${Math.round(dom)} days`);
  let s = parts.join(", ") + ".";
  if (states.length) s += ` Mostly in ${states.join(", ")}.`;
  return s;
}

export default function ICPPage() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cohort, setCohort] = useState<Row[]>([]);
  const [baseline, setBaseline] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Load tags (default-select the positive-intent ones) + the baseline sample once.
  useEffect(() => {
    (async () => {
      const [{ data: tagRows }, { data: baseRows }] = await Promise.all([
        supabase.from("outreach_tags" as any).select("id,label,color").order("created_at"),
        supabase.from("outreach_contacts").select(CURATED_COLS).limit(BASELINE_SAMPLE),
      ]);
      const ts = (tagRows as unknown as Tag[]) || [];
      setTags(ts);
      setBaseline((baseRows as Row[]) || []);
      const def = new Set(ts.filter((t) => DEFAULT_TAGS.includes((t.label || "").toLowerCase())).map((t) => t.id));
      setSelected(def);
      setLoading(false);
    })();
  }, []);

  const loadCohort = useCallback(async (tagIds: Set<string>) => {
    if (tagIds.size === 0) { setCohort([]); return; }
    setBusy(true);
    // tag -> contact ids
    const { data: links } = await supabase.from("contact_tags" as any)
      .select("contact_id").in("tag_id", [...tagIds]);
    const ids = [...new Set(((links as any[]) || []).map((l) => l.contact_id).filter(Boolean))];
    if (!ids.length) { setCohort([]); setBusy(false); return; }
    const rows: Row[] = [];
    for (let i = 0; i < ids.length; i += 300) {
      const { data } = await supabase.from("outreach_contacts").select(COHORT_COLS).in("id", ids.slice(i, i + 300));
      rows.push(...((data as Row[]) || []));
    }
    setCohort(rows);
    setBusy(false);
  }, []);

  // Export the cohort as the extension's INPUT file: one row per responder with the
  // details needed to look the property up and to match the enriched data back on return.
  const exportCohort = () => {
    if (!cohort.length) return;
    const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = EXPORT_FIELDS.join(",");
    const lines = cohort.map((r) => EXPORT_FIELDS.map((f) => esc(r[f])).join(","));
    const csv = [header, ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `icp-cohort-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => { if (!loading) void loadCohort(selected); }, [selected, loading, loadCohort]);

  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const cohortLabel = useMemo(() => tags.filter((t) => selected.has(t.id)).map((t) => t.label).join(" + ") || "none", [tags, selected]);
  const enriched = useMemo(() => cohort.filter((r) => r.property_data && typeof r.property_data === "object"), [cohort]);
  const summary = useMemo(() => icpSummary(cohort, enriched), [cohort, enriched]);

  if (loading) return <div className="flex items-center justify-center h-64 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>;

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2"><Target className="w-5 h-5 text-primary" />Ideal Customer Profile</h2>
          <p className="text-sm text-muted-foreground mt-0.5">What your best leads look like. Pick the pipeline tags that count as a win; every stat is shown against a sampled baseline of all contacts so the contrast is the signal.</p>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <button onClick={exportCohort} disabled={busy || cohort.length === 0} title="Download this cohort as the enrichment extension's input file"
            className="inline-flex items-center gap-1.5 h-8 px-3 text-xs rounded-lg border border-border hover:bg-muted/60 disabled:opacity-50">
            <Download className="w-3.5 h-3.5" />Export for enrichment
          </button>
          <button onClick={() => loadCohort(selected)} disabled={busy}
            className="inline-flex items-center gap-1.5 h-8 px-3 text-xs rounded-lg border border-border hover:bg-muted/60 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Refresh
          </button>
        </div>
      </div>

      {/* Cohort selector */}
      <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
        <p className="text-xs font-medium text-muted-foreground mb-2">ICP cohort — contacts carrying any of these tags</p>
        <div className="flex flex-wrap gap-1.5">
          {tags.length === 0 && <span className="text-xs text-muted-foreground">No tags yet. Tag some replies in the Mailbox first.</span>}
          {tags.map((t) => (
            <button key={t.id} onClick={() => toggle(t.id)}
              className={cn("inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors",
                selected.has(t.id) ? "border-primary bg-primary/10 text-foreground font-medium" : "border-border text-muted-foreground hover:bg-muted/50")}>
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.color }} />{t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Headline */}
      <div className="flex items-center gap-2 text-sm">
        <Users className="w-4 h-4 text-muted-foreground" />
        <span className="font-medium text-foreground">{cohort.length}</span>
        <span className="text-muted-foreground">contacts in cohort ({cohortLabel})</span>
        <span className="text-muted-foreground/60">· baseline sample {baseline.length.toLocaleString()}</span>
      </div>

      {cohort.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Select at least one tag with contacts to build the ICP.
        </div>
      ) : (
        <>
          {/* Auto-written profile — reads the current cohort back in plain English. */}
          {summary && (
            <div className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
              <p className="text-[11px] font-medium text-primary/80 uppercase tracking-wide mb-1">ICP summary</p>
              <p className="text-sm text-foreground leading-relaxed">{summary}</p>
            </div>
          )}

          {/* Numeric medians: cohort vs baseline */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {NUMERIC.map(({ key, label, money, int }) => {
              const c = nums(cohort, key), b = nums(baseline, key);
              const cMed = median(c), bMed = median(b);
              const delta = cMed != null && bMed != null && bMed !== 0 ? Math.round(((cMed - bMed) / bMed) * 100) : null;
              return (
                <div key={key} className="rounded-xl border border-border/60 p-3">
                  <p className="text-[11px] text-muted-foreground">{label}</p>
                  <p className="text-lg font-semibold text-foreground mt-0.5">{fmt(cMed, money, int)}</p>
                  <p className="text-[11px] text-muted-foreground/70">
                    base {fmt(bMed, money, int)}
                    {delta != null && (
                      <span className={cn("ml-1 font-medium", delta > 0 ? "text-emerald-600" : delta < 0 ? "text-rose-600" : "")}>
                        {delta > 0 ? "+" : ""}{delta}%
                      </span>
                    )}
                  </p>
                  <p className="text-[10px] text-muted-foreground/50 mt-0.5">median · n={c.length}</p>
                </div>
              );
            })}
          </div>

          {/* Categorical top lists: cohort share vs baseline share */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {CATEGORICAL.map(({ key, label }) => {
              const top = topCounts(cohort, key);
              const baseShare = new Map(topCounts(baseline, key, 50).map((r) => [r.value, r.pct]));
              return (
                <div key={key} className="rounded-xl border border-border/60 p-3">
                  <p className="text-xs font-medium text-foreground mb-2">{label}</p>
                  {top.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No data yet.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {top.map((r) => (
                        <div key={r.value} className="text-[11px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-foreground">{r.value}</span>
                            <span className="text-muted-foreground shrink-0">{r.pct}%<span className="text-muted-foreground/50"> (base {baseShare.get(r.value) ?? 0}%)</span></span>
                          </div>
                          <div className="h-1.5 rounded-full bg-muted mt-0.5 overflow-hidden">
                            <div className="h-full bg-primary/70" style={{ width: `${r.pct}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Enriched signals — only present on contacts whose full PropStream record was
              captured (via the enrichment extension). Cohort-only (baseline isn't enriched). */}
          {(() => {
            return (
              <div className="rounded-xl border border-border/60 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-foreground">Enriched signals · full PropStream data</p>
                  <span className="text-[10px] text-muted-foreground/60">{enriched.length} of {cohort.length} enriched</span>
                </div>
                {enriched.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">No enriched records in this cohort yet. Run the enrichment extension, then import, and these fill in.</p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                      {PD_NUMERIC.map(({ key, label, money, pct }) => {
                        const v = pdNums(enriched, key); const m = median(v);
                        return (
                          <div key={key} className="rounded-lg bg-muted/30 p-2.5">
                            <p className="text-[11px] text-muted-foreground">{label}</p>
                            <p className="text-base font-semibold text-foreground mt-0.5">{pct ? fmtPct(m) : fmt(m, money)}</p>
                            <p className="text-[10px] text-muted-foreground/50">median · n={v.length}</p>
                          </div>
                        );
                      })}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {PD_BOOL.map(({ key, label }) => {
                        const s = pdBoolShare(enriched, key);
                        return (
                          <div key={key} className="text-[11px]">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-foreground">{label}</span>
                              <span className="text-muted-foreground shrink-0">{s ? `${s.pct}%` : "—"}<span className="text-muted-foreground/50">{s ? ` · n=${s.n}` : ""}</span></span>
                            </div>
                            <div className="h-1.5 rounded-full bg-muted mt-0.5 overflow-hidden">
                              <div className="h-full bg-primary/70" style={{ width: `${s?.pct ?? 0}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          <p className="text-[11px] text-muted-foreground/70">
            Curated fields show cohort vs a sampled baseline. Enriched signals come from the full PropStream record and appear only on contacts run through the enrichment extension, so they're cohort-only for now.
          </p>
        </>
      )}
    </div>
  );
}
