// Free, no-send DNS authentication checker for the sending domains. Uses Google's
// DNS-over-HTTPS (the same host emailVerify.ts already uses for MX), so it needs no AWS
// credentials and no emails sent — you can run it while the domains are warming.
//
// It checks the records that decide whether Amazon SES mail authenticates and lands in
// the inbox: SPF, DMARC, and the Custom MAIL FROM setup — including the doubled
// `mail.<domain>.<domain>` mistake (entering the full subdomain into SES's MAIL FROM
// field, which then appends the domain again). DKIM tokens are per-identity and cannot
// be read from DNS, so that one is reported as a manual check with clear guidance.

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface DomainCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string; // shown when status is warn/fail
  link?: { label: string; url: string }; // optional external action (e.g. open a dashboard)
}

export interface DomainReport {
  domain: string;
  region: string | null;
  verdict: CheckStatus;
  checks: DomainCheck[];
}

const DOH = "https://dns.google/resolve";

async function doh(name: string, type: "TXT" | "MX" | "CNAME" | "A"): Promise<string[]> {
  try {
    const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
    });
    if (!res.ok) return [];
    const json = await res.json();
    // NXDOMAIN (3) or no Answer => empty. Strip the quotes DoH wraps TXT chunks in and
    // join split TXT strings (SPF/DMARC can span multiple quoted chunks).
    const answers = (json.Answer as { type: number; data: string }[] | undefined) || [];
    return answers.map((a) => a.data.replace(/^"|"$/g, "").replace(/" "/g, ""));
  } catch {
    return [];
  }
}

// SES SMTP host encodes the region: email-smtp.<region>.amazonaws.com.
export function regionFromSmtpHost(host?: string | null): string | null {
  const m = /email-smtp\.([a-z0-9-]+)\.amazonaws\.com/i.exec(host || "");
  return m ? m[1] : null;
}

export function domainOf(email: string): string {
  return (email.split("@")[1] || "").toLowerCase().trim();
}

async function checkSpf(domain: string): Promise<DomainCheck> {
  const txt = await doh(domain, "TXT");
  const spf = txt.filter((t) => /^v=spf1/i.test(t.trim()));
  if (spf.length === 0) {
    return {
      id: "spf", label: "SPF", status: "fail",
      detail: "No SPF record found on the domain.",
      fix: `Add a TXT record at ${domain}: "v=spf1 include:amazonses.com ~all"`,
    };
  }
  if (spf.length > 1) {
    return {
      id: "spf", label: "SPF", status: "fail",
      detail: `Found ${spf.length} SPF records. A domain may have only one, or SPF fails entirely.`,
      fix: "Merge them into a single v=spf1 record that includes amazonses.com.",
    };
  }
  const rec = spf[0];
  if (/amazonses\.com|amazonaws\.com/i.test(rec)) {
    return { id: "spf", label: "SPF", status: "pass", detail: `Authorizes Amazon SES. (${rec})` };
  }
  // Not listing SES here is only a problem if SES sends with the ROOT domain as the
  // envelope (Return-Path). With a Custom MAIL FROM, SES authenticates SPF on that
  // subdomain instead, so this is downgraded to a pass by checkDomain when MAIL FROM is
  // set. Left as a warn only for the no-Custom-MAIL-FROM case.
  return {
    id: "spf", label: "SPF", status: "warn",
    detail: `This root SPF doesn't list Amazon SES. (${rec})`,
    fix: "For SES, set up a Custom MAIL FROM domain (see below) so SPF authenticates on mail." + domain + " and aligns for DMARC. You don't need to add SES to this root record.",
  };
}

async function checkDmarc(domain: string): Promise<DomainCheck> {
  const txt = await doh(`_dmarc.${domain}`, "TXT");
  const dmarc = txt.find((t) => /^v=DMARC1/i.test(t.trim()));
  if (!dmarc) {
    return {
      id: "dmarc", label: "DMARC", status: "fail",
      detail: "No DMARC record. Gmail and Yahoo now require one for bulk senders.",
      fix: `Add a TXT record at _dmarc.${domain}: "v=DMARC1; p=none; rua=mailto:you@${domain}" and tighten to p=quarantine once SPF/DKIM pass.`,
    };
  }
  const policy = (/\bp=([a-z]+)/i.exec(dmarc)?.[1] || "none").toLowerCase();
  if (policy === "none") {
    return {
      id: "dmarc", label: "DMARC", status: "warn",
      detail: "DMARC is present but set to p=none (monitoring only). It satisfies the bulk-sender requirement but does not protect the domain.",
      fix: "Once SPF and DKIM both pass, move to p=quarantine, then p=reject.",
    };
  }
  return { id: "dmarc", label: "DMARC", status: "pass", detail: `Enforcing (p=${policy}).` };
}

async function checkMailFrom(domain: string, region: string | null): Promise<DomainCheck> {
  const reg = region || "us-east-1";
  const feedback = `feedback-smtp.${reg}.amazonses.com`;
  // The exact bug from the screenshot: the record lives at mail.<domain>.<domain>.
  const doubled = `mail.${domain}.${domain}`;
  const doubledMx = await doh(doubled, "MX");
  if (doubledMx.length > 0) {
    return {
      id: "mailfrom", label: "Custom MAIL FROM", status: "fail",
      detail: `Doubled MAIL FROM domain detected: ${doubled}. This is why Gmail shows "mailed-by: ${doubled}".`,
      fix: `In SES → Verified identities → ${domain} → Custom MAIL FROM, the subdomain field wants just "mail", not "mail.${domain}". Set it to "mail", then republish the MX/SPF records it gives you at mail.${domain}.`,
    };
  }
  const mailMx = await doh(`mail.${domain}`, "MX");
  const hasSes = mailMx.some((m) => new RegExp(feedback.replace(/\./g, "\\."), "i").test(m) || /feedback-smtp\..*\.amazonses\.com/i.test(m));
  if (mailMx.length > 0 && hasSes) {
    // The MAIL FROM subdomain also needs its own SPF or it soft-fails alignment.
    const mailTxt = await doh(`mail.${domain}`, "TXT");
    const spfOk = mailTxt.some((t) => /v=spf1/i.test(t) && /amazonses|amazonaws/i.test(t));
    if (!spfOk) {
      return {
        id: "mailfrom", label: "Custom MAIL FROM", status: "warn",
        detail: `MAIL FROM is set to mail.${domain} but it has no SPF record, so it will soft-fail SPF alignment.`,
        fix: `Add a TXT record at mail.${domain}: "v=spf1 include:amazonses.com ~all" (SES lists it under the identity).`,
      };
    }
    return { id: "mailfrom", label: "Custom MAIL FROM", status: "pass", detail: `Set correctly (mail.${domain} → ${feedback}).` };
  }
  return {
    id: "mailfrom", label: "Custom MAIL FROM", status: "info",
    detail: "No custom MAIL FROM configured. This is optional; SES uses amazonses.com as the Return-Path, which works fine.",
    fix: `Optional: set it up for a cleaner "mailed-by" line and strict-DMARC alignment. In SES, enter just "mail" as the subdomain.`,
  };
}

// Google Postmaster Tools is the only way to see the spam rate and reputation Gmail
// assigns a domain. Verifying it uses the standard google-site-verification TXT record at
// the root, so its presence is the DNS-checkable half of "is this domain set up in
// Postmaster Tools". The user still has to add the domain in the Postmaster UI.
async function checkPostmaster(domain: string): Promise<DomainCheck> {
  const txt = await doh(domain, "TXT");
  const verified = txt.some((t) => /google-site-verification=/i.test(t));
  const link = { label: "Open Postmaster Tools", url: "https://postmaster.google.com/" };
  if (verified) {
    return {
      id: "postmaster", label: "Google Postmaster Tools", status: "pass",
      detail: "A Google domain-verification record is present. Confirm the domain is added in Postmaster Tools to watch its Gmail spam rate and reputation.",
      link,
    };
  }
  return {
    id: "postmaster", label: "Google Postmaster Tools", status: "info",
    detail: "No google-site-verification TXT found at the root. If Postmaster already shows this domain as Verified, you verified it another way (CNAME, Search Console, or Workspace) and Google's status is what counts — ignore this. Only the TXT method is visible from DNS.",
    fix: `If it isn't set up yet: add the domain in Postmaster Tools, then publish the google-site-verification TXT record it gives you at ${domain}.`,
    link,
  };
}

function dkimCheck(domain: string): DomainCheck {
  return {
    id: "dkim", label: "DKIM", status: "info",
    detail: "DKIM keys are per-identity and cannot be read from DNS without the SES-generated selector.",
    fix: `Confirm all 3 DKIM CNAMEs show "Verified" under SES → Verified identities → ${domain}.`,
  };
}

const RANK: Record<CheckStatus, number> = { pass: 0, info: 0, warn: 1, fail: 2 };

export async function checkDomain(domain: string, region: string | null): Promise<DomainReport> {
  const [spfRaw, dmarc, mailfrom, postmaster] = await Promise.all([
    checkSpf(domain),
    checkDmarc(domain),
    checkMailFrom(domain, region),
    checkPostmaster(domain),
  ]);
  let spf = spfRaw;
  // SES SPF nuance: SPF authenticates the envelope (MAIL FROM) domain, not the visible
  // From domain. When a Custom MAIL FROM is correctly set, SES SPF lives on that
  // subdomain (mail.<domain> → include:amazonses.com), so the root SPF not listing SES
  // is fine, not a warning. Only downgrade when MAIL FROM actually passes.
  if (mailfrom.status === "pass" && spf.status === "warn") {
    spf = {
      id: "spf", label: "SPF", status: "pass",
      detail: `SES is authenticated through your Custom MAIL FROM (mail.${domain}), which carries include:amazonses.com. This root SPF is for your other mail and is correct as-is.`,
    };
  }
  const checks = [spf, dmarc, mailfrom, dkimCheck(domain), postmaster];
  const worst = checks.reduce<CheckStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), "pass");
  return { domain, region, verdict: worst, checks };
}
