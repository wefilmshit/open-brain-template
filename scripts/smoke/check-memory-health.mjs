#!/usr/bin/env node

const baseUrl = process.env.MEMORY_API_URL;
const token = process.env.MEMORY_API_TOKEN || process.env.MEMORY_MCP_TOKEN || "";

if (!baseUrl) {
  console.error("Missing MEMORY_API_URL. Example: MEMORY_API_URL=https://your-memory-api.example.com node scripts/smoke/check-memory-health.mjs");
  process.exit(2);
}

const headers = token
  ? { Authorization: `Bearer ${token}`, "x-api-key": token }
  : {};

function endpoint(path) {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function fetchJson(path, label) {
  const started = Date.now();
  const response = await fetch(endpoint(path), { headers });
  const text = await response.text();
  const durationMs = Date.now() - started;
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }

  return {
    label,
    path,
    status: response.status,
    ok: response.ok,
    duration_ms: durationMs,
    body,
  };
}

const checks = [];

for (const [path, label] of [
  ["/health", "health"],
  ["/recent?limit=3", "recent"],
  ["/stats", "stats"],
]) {
  try {
    checks.push(await fetchJson(path, label));
  } catch (error) {
    checks.push({
      label,
      path,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const required = checks.filter((check) => check.label !== "stats");
const failedRequired = required.filter((check) => !check.ok);

console.log(JSON.stringify({ ok: failedRequired.length === 0, checks }, null, 2));
process.exit(failedRequired.length === 0 ? 0 : 1);
