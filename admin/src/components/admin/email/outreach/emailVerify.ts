// Free, no-API email verification. Catches the bounces we CAN detect without paying:
//  - bad syntax
//  - dead / non-mail domains (no MX and no A record) via free DNS-over-HTTPS
//  - disposable/throwaway domains
//  - role addresses (info@, no-reply@ …) — flagged, not auto-blocked (B2B often uses them)
//  - obvious typos of big providers (gmial.com → gmail.com)
// It CANNOT tell whether a real mailbox exists on a live domain (that needs an SMTP probe,
// which the platform blocks, or a paid verifier). Those are caught reactively by the SES
// bounce feedback loop instead.

export type EmailVerdict = "valid" | "invalid_syntax" | "no_mx" | "disposable" | "role" | "typo";

export interface EmailCheck {
  email: string;
  verdict: EmailVerdict;
  reason: string;
  suggestion?: string; // for typos
  block: boolean;       // should go on the blacklist (won't deliver)
}

const SYNTAX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Big providers — known-good MX, so we skip the DNS lookup for them (the bulk of any list).
const KNOWN_GOOD = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com",
  "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "gmx.com", "zoho.com", "yandex.com", "mail.com",
]);

// Common disposable / throwaway domains (not exhaustive, but the frequent offenders).
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "sharklasers.com", "grr.la",
  "10minutemail.com", "temp-mail.org", "tempmail.com", "throwawaymail.com", "getnada.com",
  "trashmail.com", "yopmail.com", "dispostable.com", "maildrop.cc", "fakeinbox.com",
  "mailnesia.com", "mohmal.com", "emailondeck.com", "spamgourmet.com", "mytemp.email",
  "tempmailo.com", "tempr.email", "moakt.com", "mailcatch.com", "inboxkitten.com",
  "burnermail.io", "33mail.com", "spam4.me", "temp-mail.io", "luxusmail.org", "vomoto.com",
  "1secmail.com", "1secmail.org", "1secmail.net", "wegwerfmail.de", "einrot.com",
]);

const ROLE_LOCALPARTS = new Set([
  "info", "admin", "administrator", "sales", "support", "help", "helpdesk", "contact",
  "hello", "hi", "team", "billing", "accounts", "accounting", "noreply", "no-reply",
  "donotreply", "do-not-reply", "postmaster", "webmaster", "hostmaster", "office", "mail",
  "email", "marketing", "hr", "jobs", "careers", "press", "media", "legal", "privacy",
  "abuse", "enquiries", "inquiries", "orders", "service", "customerservice", "feedback",
  "newsletter", "notifications", "notification", "system", "root",
]);

// Providers people fat-finger; used for typo suggestions.
const POPULAR = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "live.com", "protonmail.com"];

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function closestTypo(domain: string): string | null {
  if (KNOWN_GOOD.has(domain) || POPULAR.includes(domain)) return null;
  for (const p of POPULAR) {
    const d = levenshtein(domain, p);
    if (d > 0 && d <= 2) return p;
  }
  return null;
}

// DNS-over-HTTPS (Google, CORS-enabled). Returns true if the domain can receive mail
// (has MX, or falls back to an A record per RFC 5321). Cached per domain.
const mxCache = new Map<string, boolean>();
async function domainCanReceiveMail(domain: string): Promise<boolean> {
  if (KNOWN_GOOD.has(domain)) return true;
  if (mxCache.has(domain)) return mxCache.get(domain)!;
  const query = async (type: "MX" | "A") => {
    try {
      const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
      });
      if (!res.ok) return null; // unknown → don't over-block
      const j = await res.json();
      if (j.Status === 3) return false; // NXDOMAIN: domain doesn't exist
      return Array.isArray(j.Answer) && j.Answer.length > 0;
    } catch {
      return null; // network hiccup → unknown, don't block
    }
  };
  const mx = await query("MX");
  let ok: boolean;
  if (mx === true) ok = true;
  else if (mx === false) ok = false; // NXDOMAIN
  else {
    const a = await query("A");
    ok = a === null ? true : a; // if A lookup also unknown, don't block
  }
  mxCache.set(domain, ok);
  return ok;
}

async function checkOne(raw: string): Promise<EmailCheck> {
  const email = (raw || "").trim().toLowerCase();
  if (!SYNTAX.test(email)) return { email, verdict: "invalid_syntax", reason: "Not a valid email format", block: true };
  const [local, domain] = email.split("@");

  if (DISPOSABLE.has(domain)) return { email, verdict: "disposable", reason: "Disposable/throwaway domain", block: true };

  const typo = closestTypo(domain);
  if (typo) return { email, verdict: "typo", reason: `Looks like a typo of ${typo}`, suggestion: `${local}@${typo}`, block: false };

  const canReceive = await domainCanReceiveMail(domain);
  if (!canReceive) return { email, verdict: "no_mx", reason: "Domain can't receive mail (no MX/A record)", block: true };

  if (ROLE_LOCALPARTS.has(local)) return { email, verdict: "role", reason: "Role address (info@, no-reply@ …)", block: false };

  return { email, verdict: "valid", reason: "Looks deliverable", block: false };
}

// Verify a list. Dedupes by email, runs domain lookups with light concurrency, reports
// progress. Domains are cached so shared providers cost one lookup each.
export async function verifyEmails(emails: string[], onProgress?: (done: number, total: number) => void): Promise<EmailCheck[]> {
  const unique = [...new Set(emails.map((e) => (e || "").trim().toLowerCase()).filter(Boolean))];
  const out: EmailCheck[] = [];
  const CONCURRENCY = 8;
  let done = 0;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(checkOne));
    out.push(...results);
    done += batch.length;
    onProgress?.(done, unique.length);
  }
  return out;
}

export function summarize(checks: EmailCheck[]): Record<EmailVerdict, number> {
  const s: Record<EmailVerdict, number> = { valid: 0, invalid_syntax: 0, no_mx: 0, disposable: 0, role: 0, typo: 0 };
  for (const c of checks) s[c.verdict]++;
  return s;
}
