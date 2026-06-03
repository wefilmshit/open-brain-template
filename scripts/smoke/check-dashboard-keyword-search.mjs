#!/usr/bin/env node

const dashboardUrl = process.env.OPEN_BRAIN_URL;
const token = process.env.OPEN_BRAIN_TOKEN || "";
const query = process.env.OPEN_BRAIN_SEARCH_QUERY || "memory";
const expectKeywordCopy = process.env.EXPECT_KEYWORD_COPY !== "0";

const report = {
  ok: true,
  dashboard_url: dashboardUrl || null,
  query,
  html: null,
  api: null,
  warnings: [],
};

function finish() {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

function url(path) {
  return `${dashboardUrl.replace(/\/$/, "")}${path}`;
}

async function readText(path) {
  const started = Date.now();
  const response = await fetch(url(path));
  return {
    ok: response.ok,
    status: response.status,
    duration_ms: Date.now() - started,
    text: await response.text(),
  };
}

async function readJson(path, options = {}) {
  const started = Date.now();
  const response = await fetch(url(path), options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return {
    ok: response.ok,
    status: response.status,
    duration_ms: Date.now() - started,
    body,
  };
}

if (!dashboardUrl) {
  report.ok = false;
  report.warnings.push("Missing OPEN_BRAIN_URL. Example: OPEN_BRAIN_URL=https://your-dashboard.example.com OPEN_BRAIN_TOKEN=... node scripts/smoke/check-dashboard-keyword-search.mjs");
  finish();
}

try {
  const html = await readText("/");
  report.html = {
    status: html.status,
    duration_ms: html.duration_ms,
    keyword_label_found: html.text.includes("Keyword search recent memories"),
    semantic_agent_copy_found: html.text.includes("semantic recall remains in agent memory"),
    old_search_all_memories_found: html.text.includes("Search all memories"),
  };

  if (expectKeywordCopy) {
    if (!report.html.keyword_label_found) {
      report.ok = false;
      report.warnings.push("Keyword-search label not found in dashboard HTML.");
    }
    if (!report.html.semantic_agent_copy_found) {
      report.ok = false;
      report.warnings.push("Boundary copy about semantic recall remaining in agent memory not found.");
    }
    if (report.html.old_search_all_memories_found) {
      report.ok = false;
      report.warnings.push("Old misleading `Search all memories` copy is still present.");
    }
  }

  if (token) {
    const headers = { Authorization: `Bearer ${token}` };
    const api = await readJson(`/api/search?q=${encodeURIComponent(query)}`, { headers });
    report.api = {
      status: api.status,
      duration_ms: api.duration_ms,
      count: api.body?.count ?? null,
      source: api.body?.timing?.source ?? null,
      scanned: api.body?.timing?.scanned ?? null,
      scan_limit: api.body?.timing?.scan_limit ?? null,
    };

    if (!api.ok) {
      report.ok = false;
      report.warnings.push(`Authenticated dashboard search failed with status ${api.status}.`);
    }
  } else {
    report.warnings.push("OPEN_BRAIN_TOKEN not set; skipped authenticated /api/search check.");
  }
} catch (error) {
  report.ok = false;
  report.warnings.push(`Dashboard keyword-search smoke failed: ${error?.message || String(error)}`);
}

finish();
