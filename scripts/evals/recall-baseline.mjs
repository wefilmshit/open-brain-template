#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const queriesFile = process.env.RECALL_QUERIES_FILE || "audit/canonical-queries.json";
const stewardUrl = process.env.MEMORY_QUERY_URL || "";
const memoryApiUrl = process.env.MEMORY_API_URL || "";
const token = process.env.MEMORY_QUERY_TOKEN || process.env.MEMORY_API_TOKEN || process.env.MEMORY_MCP_TOKEN || "";
const outputDir = process.env.RECALL_OUTPUT_DIR || "audit/results";

if (!stewardUrl && !memoryApiUrl) {
  console.error("Set MEMORY_QUERY_URL for a Steward endpoint or MEMORY_API_URL for a raw memory API endpoint.");
  process.exit(2);
}

if (!fs.existsSync(queriesFile)) {
  console.error(`Missing query file: ${queriesFile}`);
  process.exit(2);
}

const queries = JSON.parse(fs.readFileSync(queriesFile, "utf8"));
const headers = {
  "Content-Type": "application/json",
  ...(token ? { Authorization: `Bearer ${token}`, "x-api-key": token } : {}),
};

async function runStewardQuery(item) {
  const started = Date.now();
  const response = await fetch(stewardUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: item.query, hint: item.hint || "" }),
  });
  const body = await response.json().catch(() => ({}));
  const text = body.response || body.answer || JSON.stringify(body).slice(0, 1000);
  const ids = Array.from(new Set((text.match(/\b[a-f0-9]{8}\b/gi) || []).map((id) => id.toLowerCase())));
  return {
    query: item.query,
    hint: item.hint || null,
    ok: response.ok,
    status: response.status,
    duration_ms: Date.now() - started,
    memory_ids: ids,
    response_preview: text.slice(0, 800),
    error: response.ok ? null : body.error || body.message || null,
  };
}

async function runRawSearch(item) {
  const started = Date.now();
  const response = await fetch(`${memoryApiUrl.replace(/\/$/, "")}/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: item.query,
      limit: Number(process.env.RECALL_LIMIT || 10),
      threshold: Number(process.env.RECALL_THRESHOLD || 0),
    }),
  });
  const body = await response.json().catch(() => ({}));
  const results = Array.isArray(body.results) ? body.results : Array.isArray(body.memories) ? body.memories : [];
  return {
    query: item.query,
    hint: item.hint || null,
    ok: response.ok,
    status: response.status,
    duration_ms: Date.now() - started,
    memory_ids: results.map((result) => String(result.id || "").slice(0, 8)).filter(Boolean),
    count: results.length,
    error: response.ok ? null : body.error || body.message || null,
  };
}

const timestamp = new Date().toISOString();
const results = [];

for (const item of queries) {
  results.push(stewardUrl ? await runStewardQuery(item) : await runRawSearch(item));
}

fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `${timestamp.slice(0, 10)}-recall-baseline.json`);
const report = {
  ok: results.every((result) => result.ok),
  timestamp,
  mode: stewardUrl ? "steward" : "raw-search",
  query_count: queries.length,
  results,
};

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, output_path: outputPath }, null, 2));
process.exit(report.ok ? 0 : 1);
