// The backend runs as Netlify Functions, not Supabase Edge Functions. This is a
// drop-in for supabase.functions.invoke(name, { body }) that hits /api/<name>
// (mapped to /.netlify/functions/<name> by netlify.toml) and returns the same
// { data, error } shape the ported UI expects.
export async function invokeFn<T = unknown>(
  name: string,
  opts: { body?: unknown } = {}
): Promise<{ data: T | null; error: { message: string } | null }> {
  try {
    const res = await fetch(`/api/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: opts.body != null ? JSON.stringify(opts.body) : "{}",
    });
    const text = await res.text();
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* keep raw text */ }
    if (!res.ok) {
      const message =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : text || `HTTP ${res.status}`;
      return { data: null, error: { message } };
    }
    return { data: data as T, error: null };
  } catch (e) {
    return { data: null, error: { message: String((e as Error)?.message || e) } };
  }
}
