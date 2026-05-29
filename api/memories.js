// Vercel serverless function — proxies requests to the Supabase memory-api
// Keeps the API key server-side so it's never exposed to the browser

const MEMORY_API_URL = process.env.MEMORY_API_URL;
const MEMORY_API_KEY = process.env.MEMORY_API_KEY;

export default async function handler(req, res) {
  // Require a bearer token (Supabase access token from frontend)
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return res.status(401).json({ error: "Unauthorized: missing token" });
  }

  const { path } = req.query;
  const apiPath = path ? `/${path}` : "/recent";

  // Build query string (forward limit, category, q params)
  const params = new URLSearchParams();
  if (req.query.limit) params.set("limit", req.query.limit);
  if (req.query.category) params.set("category", req.query.category);
  if (req.query.q) params.set("q", req.query.q);

  const qs = params.toString() ? `?${params.toString()}` : "";
  const url = `${MEMORY_API_URL}${apiPath}${qs}`;

  try {
    const method = ["POST", "PUT", "DELETE"].includes(req.method) ? req.method : "GET";
    const fetchOpts = {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": MEMORY_API_KEY,
      },
    };
    if (method !== "GET" && req.body) {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const response = await fetch(url, fetchOpts);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
