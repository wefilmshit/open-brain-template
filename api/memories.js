// Vercel serverless function: proxies dashboard requests to the memory-api.
// Keeps MEMORY_API_KEY server-side, and only forwards a request after
// requireDashboardAuth has verified the caller's Supabase login and email.

import { requireDashboardAuth } from "./_auth.js";

// The only calls index.html makes, and the method each one uses.
// Anything else is refused before it reaches the memory API.
const ROUTES = new Map([
  ["add", new Set(["POST"])],
  ["delete", new Set(["DELETE"])],
  ["recent", new Set(["GET"])],
  ["search", new Set(["GET"])],
  ["update", new Set(["PUT"])],
]);

const ALLOWED_QUERY_PARAMS = ["limit", "offset", "category", "q"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function single(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : String(value);
}

// "recent" when no path is given; null for anything that is not a known route.
export function normalizePath(rawPath) {
  const value = single(rawPath) || "recent";
  if (!/^[a-z][a-z0-9-]*$/.test(value)) return null;
  return ROUTES.has(value) ? value : null;
}

function memoryApiBaseUrl() {
  const raw = process.env.MEMORY_API_URL;
  if (!raw || !process.env.MEMORY_API_KEY) {
    console.error("memory_proxy_error", { reason: "missing_memory_api_settings" });
    return null;
  }
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      console.error("memory_proxy_error", { reason: "insecure_memory_api_url" });
      return null;
    }
    return url;
  } catch {
    console.error("memory_proxy_error", { reason: "invalid_memory_api_url" });
    return null;
  }
}

function memoryIdFromRequest(req) {
  const id = single(req.body?.id) || single(req.query.id);
  return id && UUID.test(id) ? id : null;
}

// Builds the memory-api URL for an allowed route. Delete goes to /<uuid>.
export function buildMemoryApiUrl(baseUrl, route, req) {
  const base = baseUrl.href.replace(/\/+$/, "");
  if (route === "delete") {
    const id = memoryIdFromRequest(req);
    if (!id) throw Object.assign(new Error("Missing or invalid memory id"), { statusCode: 400 });
    return new URL(`${base}/${encodeURIComponent(id)}`);
  }
  const url = new URL(`${base}/${route}`);
  for (const key of ALLOWED_QUERY_PARAMS) {
    const value = single(req.query[key]);
    if (value != null && value.length <= 500) url.searchParams.set(key, value);
  }
  return url;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: response.ok ? "Invalid upstream response" : "Memory API request failed" };
  }
}

export default async function handler(req, res) {
  const auth = await requireDashboardAuth(req, res);
  if (!auth) return;

  const route = normalizePath(req.query.path);
  if (!route) return res.status(404).json({ error: "Not found" });

  const methods = ROUTES.get(route);
  if (!methods.has(req.method)) {
    res.setHeader("Allow", [...methods].join(", "));
    return res.status(405).json({ error: "Method not allowed" });
  }

  const baseUrl = memoryApiBaseUrl();
  if (!baseUrl) return res.status(503).json({ error: "Memory service unavailable" });

  let url;
  try {
    url = buildMemoryApiUrl(baseUrl, route, req);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message || "Invalid request" });
  }

  try {
    const fetchOpts = {
      method: req.method,
      headers: { "Content-Type": "application/json", "x-api-key": process.env.MEMORY_API_KEY },
    };
    // A delete is fully named by the URL; no body is forwarded with it.
    if (req.method !== "GET" && route !== "delete" && req.body) {
      fetchOpts.body = JSON.stringify(req.body);
    }
    const response = await fetch(url, fetchOpts);
    const data = await readJson(response);
    return res.status(response.status).json(data);
  } catch (err) {
    console.error("memory_proxy_error", { reason: "request_failed", error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: "Internal error" });
  }
}
