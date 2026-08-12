import nodemailer from "nodemailer";
import { admin, json } from "../lib/shared.mjs";

// Verify a sender's SMTP credentials (used by the Senders UI "Test" button).
// Accepts either { sender_account_id } or inline { smtp_host, smtp_port, ... }.
export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    let cfg = await req.json().catch(() => ({}));
    if (cfg.sender_account_id) {
      const { data: s } = await admin()
        .from("email_sender_accounts").select("*").eq("id", cfg.sender_account_id).maybeSingle();
      if (!s) return json({ ok: false, error: "sender not found" }, 404);
      cfg = s;
    }
    if (!cfg.smtp_host || !cfg.smtp_user || !cfg.smtp_password) {
      return json({ ok: false, error: "missing smtp credentials" }, 400);
    }
    const port = cfg.smtp_port || 587;
    const transport = nodemailer.createTransport({
      host: cfg.smtp_host, port, secure: port === 465, requireTLS: port === 587,
      auth: { user: cfg.smtp_user, pass: cfg.smtp_password },
      connectionTimeout: 12000, greetingTimeout: 12000,
    });
    await transport.verify();
    return json({ ok: true, message: "SMTP connection and auth succeeded" });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 200);
  }
};
