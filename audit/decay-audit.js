#!/usr/bin/env node
/**
 * Open Brain — Decay Audit
 *
 * Replays a fixed set of canonical memory_query calls against your Memory
 * Steward endpoint, saves a timestamped snapshot of the cited memory IDs,
 * and diffs the latest run against the previous one to flag retrieval drift.
 *
 * Runs weekly via .github/workflows/decay-audit.yml or on demand with:
 *   MEMORY_MCP_URL=https://... MEMORY_MCP_TOKEN=... node audit/decay-audit.js
 */

const fs = require("fs");
const path = require("path");

const MCP_URL = process.env.MEMORY_MCP_URL;
const MCP_TOKEN = process.env.MEMORY_MCP_TOKEN;
const QUERIES_FILE =
  process.env.QUERIES_FILE || path.join(__dirname, "canonical-queries.json");
const OUTPUT_DIR = path.join(__dirname, "results");

if (!MCP_URL || !MCP_TOKEN) {
  console.error(
    "Missing MEMORY_MCP_URL or MEMORY_MCP_TOKEN env var. Set them and retry."
  );
  process.exit(1);
}

async function runQuery(query, hint) {
  const started = Date.now();
  const res = await fetch(`${MCP_URL.replace(/\/$/, "")}/memory/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MCP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, hint }),
  });
  const body = await res.json().catch(() => ({ ok: false, raw: "unparseable" }));
  const total_duration_ms = Date.now() - started;

  // Memory IDs are emitted as (abc12345) or **[cat]** (abc12345) in the synthesized answer.
  const idMatches = (body.response || "").match(/\(([a-f0-9]{8})\)/g) || [];
  const memory_ids = Array.from(new Set(idMatches.map((m) => m.slice(1, -1))));

  return {
    query,
    hint: hint || null,
    ok: !!body.ok,
    response: body.response || null,
    memory_ids,
    iterations: body.iterations ?? null,
    server_duration_ms: body.duration_ms ?? null,
    total_duration_ms,
    session_id: body.session_id || null,
    error: body.ok ? null : body.error || body.raw || null,
  };
}

function jaccard(a, b) {
  const A = new Set(a),
    B = new Set(b);
  if (!A.size && !B.size) return 1;
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return uni ? inter / uni : 0;
}

async function main() {
  const queries = JSON.parse(fs.readFileSync(QUERIES_FILE, "utf8"));
  const timestamp = new Date().toISOString();
  const run_date = timestamp.slice(0, 10);

  console.log(
    `Decay audit — ${queries.length} queries against ${MCP_URL} (${run_date})`
  );

  const results = [];
  for (const q of queries) {
    const preview = q.query.slice(0, 60);
    process.stdout.write(`  ${preview}${q.query.length > 60 ? "..." : ""}\n`);
    try {
      const r = await runQuery(q.query, q.hint);
      results.push(r);
      console.log(
        `    → ok=${r.ok} ids=${r.memory_ids.length} t=${r.total_duration_ms}ms`
      );
    } catch (e) {
      results.push({ query: q.query, ok: false, error: e.message });
      console.log(`    → ERROR: ${e.message}`);
    }
  }

  const snapshot = {
    run_date,
    timestamp,
    mcp_url: MCP_URL,
    query_count: queries.length,
    ok_count: results.filter((r) => r.ok).length,
    results,
  };

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outfile = path.join(OUTPUT_DIR, `${run_date}.json`);
  fs.writeFileSync(outfile, JSON.stringify(snapshot, null, 2));
  console.log(`\nSnapshot saved: ${path.relative(process.cwd(), outfile)}`);

  // Drift check vs most recent prior snapshot.
  const runs = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (runs.length >= 2) {
    const prev = JSON.parse(
      fs.readFileSync(path.join(OUTPUT_DIR, runs[runs.length - 2]), "utf8")
    );
    const drift = [];
    for (let i = 0; i < snapshot.results.length; i++) {
      const now = snapshot.results[i];
      const then = prev.results.find((r) => r.query === now.query);
      if (!then) continue;
      const nowIds = now.memory_ids || [];
      const thenIds = then.memory_ids || [];
      const removed = thenIds.filter((id) => !nowIds.includes(id));
      const added = nowIds.filter((id) => !thenIds.includes(id));
      const overlap = jaccard(nowIds, thenIds);
      if (removed.length || added.length) {
        drift.push({
          query: now.query,
          jaccard: Number(overlap.toFixed(2)),
          removed,
          added,
        });
      }
    }
    console.log(`\nDrift vs ${prev.run_date}:`);
    if (drift.length === 0) {
      console.log("  none — every query returned the same cited memories.");
    } else {
      drift.forEach((d) =>
        console.log(
          `  j=${d.jaccard} "${d.query.slice(0, 50)}"  -${d.removed.length} +${d.added.length}`
        )
      );
    }
  } else {
    console.log("\nNo prior snapshot to diff against. This run is the baseline.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
