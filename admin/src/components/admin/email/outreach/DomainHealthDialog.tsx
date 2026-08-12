import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, XCircle, Info, RefreshCw, ShieldCheck, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { checkDomain, type DomainReport, type CheckStatus } from "./dnsCheck";

// One place to see whether every sending domain is set up to authenticate: SPF, DMARC,
// and the Custom MAIL FROM (including the doubled mail.<domain>.<domain> mistake). Runs
// entirely over DNS-over-HTTPS, so it works with nothing sent — ideal during warmup.

interface DomainInput { domain: string; region: string | null }

const STATUS_ICON: Record<CheckStatus, JSX.Element> = {
  pass: <CheckCircle2 className="w-4 h-4 text-emerald-600" />,
  warn: <AlertTriangle className="w-4 h-4 text-amber-600" />,
  fail: <XCircle className="w-4 h-4 text-red-600" />,
  info: <Info className="w-4 h-4 text-muted-foreground" />,
};
const VERDICT_STYLE: Record<CheckStatus, string> = {
  pass: "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700",
  warn: "border-amber-300 bg-amber-50 dark:bg-amber-950/20 text-amber-700",
  fail: "border-red-300 bg-red-50 dark:bg-red-950/20 text-red-700",
  info: "border-border bg-muted/30 text-muted-foreground",
};
const VERDICT_WORD: Record<CheckStatus, string> = { pass: "Ready", warn: "Needs attention", fail: "Broken", info: "Review" };

export default function DomainHealthDialog({ open, onOpenChange, domains }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  domains: DomainInput[];
}) {
  const [reports, setReports] = useState<Record<string, DomainReport | "loading">>({});
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    if (domains.length === 0) return;
    setRunning(true);
    setReports(Object.fromEntries(domains.map((d) => [d.domain, "loading" as const])));
    // Sequentially-ish but parallel across domains; each domain fans out its own checks.
    await Promise.all(domains.map(async (d) => {
      const r = await checkDomain(d.domain, d.region);
      setReports((prev) => ({ ...prev, [d.domain]: r }));
    }));
    setRunning(false);
  }, [domains]);

  // Auto-run when opened so it is one click, not two.
  useEffect(() => { if (open) void run(); }, [open, run]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldCheck className="w-5 h-5" /> Domain setup check</DialogTitle>
          <DialogDescription>
            SPF, DMARC and MAIL FROM for every sending domain, read straight from DNS. Nothing is sent. Run it before and during warmup so a misconfigured domain never burns warmup time.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" onClick={run} disabled={running} className="gap-1.5">
            <RefreshCw className={cn("w-3.5 h-3.5", running && "animate-spin")} /> {running ? "Checking…" : "Re-check"}
          </Button>
          <span className="text-xs text-muted-foreground">{domains.length} domain{domains.length === 1 ? "" : "s"}</span>
        </div>

        <div className="flex-1 overflow-y-auto space-y-3 -mx-1 px-1">
          {domains.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No sender domains yet. Add a sender to check its domain.</p>
          )}
          {domains.map((d) => {
            const r = reports[d.domain];
            return (
              <div key={d.domain} className="border border-border rounded-xl overflow-hidden">
                <div className={cn("flex items-center justify-between gap-2 px-4 py-2.5 border-b", r && r !== "loading" ? VERDICT_STYLE[r.verdict] : "border-border bg-muted/30")}>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{d.domain}</p>
                    {d.region && <p className="text-[11px] opacity-70">SES region {d.region}</p>}
                  </div>
                  <span className="text-xs font-medium shrink-0">
                    {r === "loading" || !r ? "Checking…" : VERDICT_WORD[r.verdict]}
                  </span>
                </div>
                <div className="divide-y divide-border/60">
                  {r && r !== "loading" ? r.checks.map((c) => (
                    <div key={c.id} className="flex items-start gap-3 px-4 py-2.5">
                      <span className="mt-0.5 shrink-0">{STATUS_ICON[c.status]}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-foreground">{c.label}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{c.detail}</p>
                        {c.fix && (c.status === "warn" || c.status === "fail" || c.status === "info") && (
                          <p className="text-[11px] text-foreground/70 mt-1 border-l-2 border-border pl-2">{c.fix}</p>
                        )}
                        {c.link && (
                          <a href={c.link.url} target="_blank" rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline mt-1">
                            {c.link.label} <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  )) : (
                    <div className="px-4 py-6 text-center text-xs text-muted-foreground">Reading DNS…</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
