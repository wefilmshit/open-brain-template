#!/usr/bin/env node
/**
 * batch-match.mjs — Test vercel-plugin hook matching against a JSONL conversation log.
 *
 * Usage:
 *   node .claude/skills/plugin-audit/scripts/batch-match.mjs <path-to-jsonl> [--cache]
 *
 * Options:
 *   --cache    Use the installed plugin cache instead of the dev hooks
 *
 * Output: Structured report of matches, gaps, and dedup timeline.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

// Resolve plugin root (dev or cache)
const useCache = process.argv.includes("--cache");
// Script lives at .claude/skills/plugin-audit/scripts/ — 4 levels up to project root
const DEV_ROOT = resolve(import.meta.dirname, "../../../..");
const CACHE_ROOT = (() => {
  try {
    const installed = JSON.parse(
      readFileSync(resolve(process.env.HOME, ".claude/plugins/installed_plugins.json"), "utf-8")
    );
    const entries = installed?.plugins?.["vercel-plugin@vercel-labs-vercel-plugin"] || [];
    // Find the highest-version install
    const sorted = entries.slice().sort((a, b) => (b.version || "").localeCompare(a.version || ""));
    if (sorted.length > 0) return sorted[0].installPath;
  } catch {}
  return null;
})();

const PLUGIN_ROOT = useCache && CACHE_ROOT ? CACHE_ROOT : DEV_ROOT;

// Dynamic import from the resolved plugin root
const { loadSkills, matchSkills } = await import(join(PLUGIN_ROOT, "hooks/pretooluse-skill-inject.mjs"));
const { createLogger } = await import(join(PLUGIN_ROOT, "hooks/logger.mjs"));

const log = createLogger();

// ---- Parse arguments ----
const jsonlPath = process.argv.find((a) => a.endsWith(".jsonl"));
if (!jsonlPath) {
  console.error("Usage: batch-match.mjs <path-to-jsonl> [--cache]");
  process.exit(1);
}

if (!existsSync(jsonlPath)) {
  console.error(`File not found: ${jsonlPath}`);
  process.exit(1);
}

// ---- Extract tool calls from JSONL ----
const SUPPORTED_TOOLS = new Set(["Read", "Edit", "Write", "Bash"]);

function extractToolCalls(jsonlPath) {
  const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
  const toolCalls = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type === "tool_use" && SUPPORTED_TOOLS.has(block.name)) {
          toolCalls.push({
            tool_name: block.name,
            tool_input: block.input || {},
            timestamp: entry.timestamp,
            cwd: entry.cwd,
          });
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  return toolCalls;
}

// ---- Run matching ----
const toolCalls = extractToolCalls(jsonlPath);
console.log(`\n📋 Extracted ${toolCalls.length} tool calls from log\n`);

const skills = loadSkills(PLUGIN_ROOT, log);
if (!skills) {
  console.error("FATAL: Could not load skills from", PLUGIN_ROOT);
  process.exit(1);
}

console.log(`🔧 Loaded ${Object.keys(skills.skillMap).length} skills from ${useCache ? "CACHE" : "DEV"}\n`);

// Track dedup timeline
const seenSkills = new Set();
const dedupTimeline = [];
const matchMatrix = [];
let matchedCount = 0;
let unmatchedCount = 0;

for (const tc of toolCalls) {
  const result = matchSkills(tc.tool_name, tc.tool_input, skills.compiledSkills, log);
  const matched = result ? [...result.matched] : [];
  const target =
    tc.tool_name === "Bash"
      ? (tc.tool_input.command || "").slice(0, 100)
      : tc.tool_input.file_path || "";

  const newSkills = matched.filter((s) => !seenSkills.has(s));
  const dedupedSkills = matched.filter((s) => seenSkills.has(s));

  for (const s of newSkills) seenSkills.add(s);

  if (newSkills.length > 0) {
    dedupTimeline.push({
      tool: tc.tool_name,
      target: target.slice(0, 80),
      injected: newSkills,
      deduped: dedupedSkills,
    });
  }

  matchMatrix.push({
    tool: tc.tool_name,
    target,
    matched,
    reasons: result?.matchReasons || {},
  });

  if (matched.length > 0) matchedCount++;
  else unmatchedCount++;
}

// ---- Output Report ----

console.log("═══════════════════════════════════════════════════════");
console.log("  MATCH MATRIX");
console.log("═══════════════════════════════════════════════════════\n");

for (const entry of matchMatrix) {
  const status = entry.matched.length > 0 ? "✅" : "  ";
  const skills = entry.matched.length > 0 ? entry.matched.join(", ") : "—";
  const shortTarget = entry.target.length > 70 ? entry.target.slice(0, 70) + "…" : entry.target;
  console.log(`${status} ${entry.tool.padEnd(5)} │ ${shortTarget}`);
  if (entry.matched.length > 0) {
    console.log(`        → ${skills}`);
  }
}

console.log(`\n📊 ${matchedCount} matched, ${unmatchedCount} unmatched out of ${toolCalls.length} total\n`);

console.log("═══════════════════════════════════════════════════════");
console.log("  DEDUP TIMELINE (injection order)");
console.log("═══════════════════════════════════════════════════════\n");

for (let i = 0; i < dedupTimeline.length; i++) {
  const d = dedupTimeline[i];
  console.log(`${i + 1}. ${d.tool} │ ${d.target}`);
  console.log(`   injected: ${d.injected.join(", ")}`);
  if (d.deduped.length > 0) {
    console.log(`   deduped:  ${d.deduped.join(", ")}`);
  }
}

console.log(`\n🔑 ${seenSkills.size} unique skills would be injected: ${[...seenSkills].join(", ")}\n`);

// ---- Unmatched analysis ----
console.log("═══════════════════════════════════════════════════════");
console.log("  UNMATCHED TOOL CALLS");
console.log("═══════════════════════════════════════════════════════\n");

const unmatched = matchMatrix.filter((e) => e.matched.length === 0);
for (const entry of unmatched) {
  const shortTarget = entry.target.length > 80 ? entry.target.slice(0, 80) + "…" : entry.target;
  console.log(`  ${entry.tool.padEnd(5)} │ ${shortTarget}`);
}

console.log(`\n💡 Review unmatched calls above for potential pattern additions.\n`);
