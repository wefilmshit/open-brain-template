// Thin fetch wrapper around the memory-api Supabase Edge Function.
// No behavior beyond building the request and surfacing a structured error --
// the actual logic (dedup, cap, archive) lives server-side in memory-api.

export function buildClient({ apiUrl, apiKey }) {
  if (!apiUrl) throw new Error("MEMORY_API_URL is required");
  if (!apiKey) throw new Error("MEMORY_API_KEY is required");
  const base = apiUrl.replace(/\/+$/, "");

  async function call(path, { method = "GET", body } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`malformed_response: ${res.status} ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const message = data?.error || `request_failed_${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  return {
    add: (payload) => call("/add", { method: "POST", body: payload }),
    update: (payload) => call("/update", { method: "PUT", body: payload }),
    correct: (payload) => call("/correct", { method: "POST", body: payload }),
    recent: ({ limit, category } = {}) => {
      const params = new URLSearchParams();
      if (limit) params.set("limit", String(limit));
      if (category) params.set("category", category);
      const qs = params.toString() ? `?${params.toString()}` : "";
      return call(`/recent${qs}`);
    },
    search: ({ q, limit } = {}) => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (limit) params.set("limit", String(limit));
      return call(`/search?${params.toString()}`);
    },
    recall: (payload) => call("/recall", { method: "POST", body: payload }),
    stats: () => call("/stats"),
    deleteById: (id) => call(`/${encodeURIComponent(id)}`, { method: "DELETE" }),
    archive: (id, payload) => call(`/${encodeURIComponent(id)}/archive`, { method: "POST", body: payload || {} }),
    restore: (id) => call(`/${encodeURIComponent(id)}/restore`, { method: "POST", body: {} }),
  };
}
