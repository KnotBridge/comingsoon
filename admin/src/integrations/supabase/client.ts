import { createClient } from "@supabase/supabase-js";

// Public values (safe to ship in the browser — the anon key is gated by RLS).
// Provided via Vite env at build time, with a fallback to the project defaults.
const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || "https://cjvchubyctljddfwxqcj.supabase.co";
const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqdmNodWJ5Y3RsamRkZnd4cWNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1Mjg1MjUsImV4cCI6MjEwMjEwNDUyNX0.fszemihqppzvuZKDx5rncupEpdBnA692RGfdEjZi5Pw";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Persist the admin session in localStorage ("session in cache") so a
    // refresh keeps you signed in until the token expires or you log out.
    storage: window.localStorage,
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "rnq-mail-auth",
  },
});

// The backend runs as Netlify Functions, not Supabase Edge Functions. Route every
// supabase.functions.invoke("name", { body }) call to /api/name so all the ported
// UI (Send, Test SMTP, Sync replies, ...) works unchanged.
supabase.functions.invoke = async (name: string, opts: { body?: unknown } = {}) => {
  try {
    const res = await fetch(`/api/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* keep as text */ }
    if (!res.ok) {
      const message = (data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : text) || `HTTP ${res.status}`;
      return { data: null, error: { message } } as never;
    }
    return { data, error: null } as never;
  } catch (e) {
    return { data: null, error: { message: String((e as Error)?.message || e) } } as never;
  }
};
