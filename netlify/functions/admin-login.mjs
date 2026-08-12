import { createClient } from "@supabase/supabase-js";

// Verifies the shared access code server-side and returns a real Supabase admin
// session. The admin account's password lives only in Netlify env, never in the
// browser bundle. The SPA stores the returned session in localStorage.
export default async (req) => {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  let code = "";
  try {
    ({ code } = await req.json());
  } catch {
    return json({ error: "bad request" }, 400);
  }

  const ADMIN_CODE = process.env.ADMIN_CODE || "Knotbridge33";
  if (!code || code.trim() !== ADMIN_CODE) {
    return json({ error: "invalid code" }, 401);
  }

  const url = process.env.SUPABASE_URL || "https://cjvchubyctljddfwxqcj.supabase.co";
  const anon = process.env.SUPABASE_ANON_KEY;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!anon || !email || !password) {
    return json({ error: "server not configured (missing env)" }, 500);
  }

  const sb = createClient(url, anon, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data?.session) {
    return json({ error: "auth failed" }, 500);
  }

  return json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
