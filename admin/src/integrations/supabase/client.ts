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

// Backend calls go through invokeFn() in "@/integrations/functions" (which hits
// Netlify Functions at /api/*), not supabase.functions — supabase.functions is a
// getter that returns a fresh client each access, so it can't be monkey-patched.
