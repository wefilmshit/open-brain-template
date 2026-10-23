// Shared dashboard login check for the Vercel serverless functions.
//
// The browser sends the Supabase access token it got after Google sign-in.
// This file asks Supabase who that token belongs to, then checks the email
// against DASHBOARD_ALLOWED_EMAILS on the SERVER. Only then does a request go
// on to the memory API. The email list inside index.html only hides the page;
// it is not a security control, because anyone can call /api directly.
//
// The leading underscore keeps Vercel from serving this file as its own route.

function settings() {
  const supabaseUrl = process.env.DASHBOARD_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const anonKey = process.env.DASHBOARD_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";
  const allowedRaw = process.env.DASHBOARD_ALLOWED_EMAILS || "";
  const allowedEmails = allowedRaw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return { supabaseUrl, anonKey, allowedEmails };
}

function isPlaceholder(value) {
  return !value || /^YOUR_/i.test(value);
}

export function bearerToken(req) {
  const authHeader = req.headers["authorization"] || "";
  return String(authHeader).replace(/^Bearer\s+/i, "").trim();
}

// Returns { token, user } when the caller may use the dashboard API.
// Otherwise it has already answered the request and returns null.
// Every failure stops here: a missing setting never lets a request through.
export async function requireDashboardAuth(req, res) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized: missing token" });
    return null;
  }
  if (token.length > 8192) {
    res.status(400).json({ error: "Invalid authorization token" });
    return null;
  }

  const { supabaseUrl, anonKey, allowedEmails } = settings();
  if (isPlaceholder(supabaseUrl) || isPlaceholder(anonKey)) {
    console.error("dashboard_auth_config_error", { reason: "missing_or_placeholder_supabase_settings" });
    res.status(503).json({ error: "Authentication service unavailable" });
    return null;
  }
  if (!allowedEmails.length) {
    console.error("dashboard_auth_config_error", { reason: "missing_dashboard_allowed_emails" });
    res.status(503).json({ error: "Authentication service unavailable" });
    return null;
  }

  let response;
  try {
    response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    });
  } catch {
    res.status(502).json({ error: "Could not verify dashboard sign-in" });
    return null;
  }

  if (!response.ok) {
    res.status(401).json({ error: "Unauthorized: invalid token" });
    return null;
  }

  let user;
  try {
    user = await response.json();
  } catch {
    res.status(502).json({ error: "Could not verify dashboard sign-in" });
    return null;
  }
  const email = String(user?.email || "").toLowerCase();
  if (!email || !allowedEmails.includes(email)) {
    res.status(403).json({ error: "Forbidden: email not allowed" });
    return null;
  }

  return { token, user };
}
