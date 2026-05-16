#!/usr/bin/env bun
/**
 * Sandbox benchmark analyzer: reads artifacts from sandbox-runner output,
 * extracts debug logs and claim dirs, and produces a coverage report.
 *
 * Usage:
 *   bun run .claude/skills/benchmark-sandbox/sandbox-analyze.ts [options]
 *
 *   --run-dir <path>   Path to a specific run directory (default: latest in sandbox-results/)
 *   --json             Output JSON report instead of human-readable
 *   --help             Print usage and exit
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import type { RunSummary, ScenarioSummary } from "./types.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  options: {
    "run-dir": { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (flags.help) {
  console.log(`Usage: bun run .claude/skills/benchmark-sandbox/sandbox-analyze.ts [options]
  --run-dir <path>   Path to a specific run directory
  --json             Output JSON report
  --help             Print usage`);
  process.exit(0);
}

const DEFAULT_RESULTS = join(homedir(), "dev", "vercel-plugin-testing", "sandbox-results");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookCoverage {
  sessionStart: boolean;
  preToolUse: boolean;
  postToolUse: boolean;
  userPromptSubmit: boolean;
}

interface ScenarioAnalysis {
  slug: string;
  sandboxId: string;
  success: boolean;
  timedOut: boolean;
  durationSec: number;
  expectedSkills: string[];
  claimedSkills: string[];
  missingSkills: string[];
  unexpectedSkills: string[];
  coveragePercent: number;
  hookCoverage: HookCoverage;
  debugLogLines: number;
  stderrTraceLines: number;
  error?: string;
}

interface CoverageReport {
  runId: string;
  timestamp: string;
  snapshotId: string;
  totalDurationSec: number;
  scenarioCount: number;
  passCount: number;
  failCount: number;
  timeoutCount: number;
  hookFiredCount: number;
  scenarios: ScenarioAnalysis[];
  skillInjectionMatrix: Record<string, string[]>; // skill → slugs where injected
  allExpectedSkills: string[];
  allClaimedSkills: string[];
  coveragePercent: number; // expected skills that were actually claimed
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findLatestRunDir(): Promise<string> {
  const entries = await readdir(DEFAULT_RESULTS);
  const runDirs = entries.filter((e) => e.startsWith("run-")).sort().reverse();
  if (runDirs.length === 0) {
    console.error(`No run directories found in ${DEFAULT_RESULTS}`);
    process.exit(1);
  }
  return join(DEFAULT_RESULTS, runDirs[0]);
}

async function readJsonFile<T>(path: string): Promise<T> {
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as T;
}

async function countLines(path: string): Promise<number> {
  try {
    const content = await readFile(path, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

function parseHookCoverageFromDebugLogs(logContent: string): HookCoverage {
  return {
    sessionStart:
      logContent.includes("SessionStart") || logContent.includes("session-start"),
    preToolUse:
      logContent.includes("PreToolUse") ||
      logContent.includes("pretooluse") ||
      logContent.includes("skill-inject"),
    postToolUse:
      logContent.includes("PostToolUse") ||
      logContent.includes("posttooluse") ||
      logContent.includes("validate"),
    userPromptSubmit:
      logContent.includes("UserPromptSubmit") ||
      logContent.includes("user-prompt-submit") ||
      logContent.includes("prompt-signal"),
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

async function analyzeRun(runDir: string): Promise<CoverageReport> {
  const manifest = await readJsonFile<RunSummary>(join(runDir, "run-manifest.json"));

  const scenarios: ScenarioAnalysis[] = [];
  const skillInjectionMatrix: Record<string, string[]> = {};

  for (const s of manifest.scenarios) {
    const slugDir = join(runDir, s.slug);

    // Read debug logs if available
    let debugLogContent = "";
    const debugLogsDir = join(slugDir, "debug-logs");
    if (await dirExists(debugLogsDir)) {
      const logFiles = await readdir(debugLogsDir).catch(() => []);
      for (const f of logFiles) {
        debugLogContent += await readFile(join(debugLogsDir, f), "utf-8").catch(() => "");
      }
    }

    // Read stderr trace
    const stderrLines = await countLines(join(slugDir, "stderr-trace.txt"));

    // Parse hook coverage from debug logs + stderr
    let stderrContent = "";
    try {
      stderrContent = await readFile(join(slugDir, "stderr-trace.txt"), "utf-8");
    } catch { /* no stderr file */ }

    const combinedLogs = debugLogContent + "\n" + stderrContent;
    const hookCoverage = parseHookCoverageFromDebugLogs(combinedLogs);

    // If manifest already has hook evidence, merge it in
    if (s.hook_evidence.pre_tool_use_in_stderr) hookCoverage.preToolUse = true;
    if (s.hook_evidence.user_prompt_in_stderr) hookCoverage.userPromptSubmit = true;

    // Derive boolean flags from status
    const success = s.status === "pass";
    const timedOut = s.status === "timeout";

    // Compute skill coverage per scenario
    const expectedSet = new Set(s.expected_skills);
    const claimedSet = new Set(s.claimed_skills);
    const missingSkills = s.expected_skills.filter((sk) => !claimedSet.has(sk));
    const unexpectedSkills = s.claimed_skills.filter((sk) => !expectedSet.has(sk));
    const coveredCount = s.expected_skills.filter((sk) => claimedSet.has(sk)).length;
    const scenarioCoverage =
      s.expected_skills.length > 0 ? Math.round((coveredCount / s.expected_skills.length) * 100) : 100;

    // Track skill injection matrix
    for (const skill of s.claimed_skills) {
      if (!skillInjectionMatrix[skill]) skillInjectionMatrix[skill] = [];
      skillInjectionMatrix[skill].push(s.slug);
    }

    scenarios.push({
      slug: s.slug,
      sandboxId: s.sandbox_id,
      success,
      timedOut,
      durationSec: Math.round(s.duration_ms / 1000),
      expectedSkills: s.expected_skills,
      claimedSkills: s.claimed_skills,
      missingSkills,
      unexpectedSkills,
      coveragePercent: scenarioCoverage,
      hookCoverage,
      debugLogLines: debugLogContent.split("\n").length,
      stderrTraceLines: stderrLines,
      error: s.error,
    });
  }

  // Aggregate stats — average per-scenario coverage, not global unique skills
  const allExpected = [...new Set(manifest.scenarios.flatMap((s) => s.expected_skills))].sort();
  const allClaimed = [...new Set(manifest.scenarios.flatMap((s) => s.claimed_skills))].sort();
  const scenariosWithExpectations = scenarios.filter((s) => s.expectedSkills.length > 0);
  const coveragePercent =
    scenariosWithExpectations.length > 0
      ? Math.round(
          scenariosWithExpectations.reduce((sum, s) => sum + s.coveragePercent, 0) /
            scenariosWithExpectations.length,
        )
      : 0;

  return {
    runId: manifest.run_id,
    timestamp: manifest.timestamp,
    snapshotId: manifest.snapshot.snapshot_id,
    totalDurationSec: Math.round(manifest.timing.total_duration_ms / 1000),
    scenarioCount: scenarios.length,
    passCount: scenarios.filter((s) => s.success).length,
    failCount: scenarios.filter((s) => !s.success && !s.timedOut).length,
    timeoutCount: scenarios.filter((s) => s.timedOut).length,
    hookFiredCount: scenarios.filter(
      (s) => s.hookCoverage.preToolUse || s.hookCoverage.userPromptSubmit,
    ).length,
    scenarios,
    skillInjectionMatrix,
    allExpectedSkills: allExpected,
    allClaimedSkills: allClaimed,
    coveragePercent,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printReport(report: CoverageReport): void {
  console.log("=".repeat(70));
  console.log("SANDBOX BENCHMARK COVERAGE REPORT");
  console.log("=".repeat(70));
  console.log(`Run ID:     ${report.runId}`);
  console.log(`Timestamp:  ${report.timestamp}`);
  console.log(`Snapshot:   ${report.snapshotId}`);
  console.log(`Duration:   ${report.totalDurationSec}s`);
  console.log();

  // Summary
  console.log("--- Summary ---");
  console.log(`Scenarios:  ${report.scenarioCount}`);
  console.log(`Passed:     ${report.passCount}`);
  console.log(`Failed:     ${report.failCount}`);
  console.log(`Timed out:  ${report.timeoutCount}`);
  console.log(`Hooks fired: ${report.hookFiredCount}/${report.scenarioCount}`);
  console.log(`Skill coverage: ${report.coveragePercent}% (${report.allClaimedSkills.length}/${report.allExpectedSkills.length} expected skills seen)`);
  console.log();

  // Scenario table
  console.log("--- Scenarios ---");
  console.log(
    `${"Slug".padEnd(28)} ${"Status".padEnd(10)} ${"Cov%".padEnd(6)} ${"Hooks".padEnd(8)} ${"Expected".padEnd(20)} ${"Claimed".padEnd(20)} Missing`,
  );
  console.log("-".repeat(116));
  for (const s of report.scenarios) {
    const status = s.timedOut ? "TIMEOUT" : s.success ? "PASS" : "FAIL";
    const covPct = `${s.coveragePercent}%`;
    const hooks = [
      s.hookCoverage.preToolUse ? "P" : "-",
      s.hookCoverage.postToolUse ? "V" : "-",
      s.hookCoverage.userPromptSubmit ? "U" : "-",
      s.hookCoverage.sessionStart ? "S" : "-",
    ].join("");
    const expected = s.expectedSkills.join(",");
    const claimed = s.claimedSkills.join(",") || "(none)";
    const missing = s.missingSkills.join(",") || "-";
    console.log(
      `${s.slug.padEnd(28)} ${status.padEnd(10)} ${covPct.padEnd(6)} ${hooks.padEnd(8)} ${expected.padEnd(20)} ${claimed.padEnd(20)} ${missing}`,
    );
    if (s.error) {
      console.log(`  ERROR: ${s.error.slice(0, 100)}`);
    }
  }
  console.log();
  console.log("Hook legend: P=PreToolUse V=PostToolUse(validate) U=UserPromptSubmit S=SessionStart");
  console.log();

  // Skill injection matrix
  console.log("--- Skill Injection Matrix ---");
  const sortedSkills = Object.entries(report.skillInjectionMatrix).sort(
    (a, b) => b[1].length - a[1].length,
  );
  for (const [skill, slugs] of sortedSkills) {
    console.log(`  ${skill.padEnd(25)} → ${slugs.join(", ")}`);
  }
  if (sortedSkills.length === 0) {
    console.log("  (no skills claimed)");
  }
  console.log();

  // Missing coverage
  const uncoveredSkills = report.allExpectedSkills.filter(
    (sk) => !report.allClaimedSkills.includes(sk),
  );
  if (uncoveredSkills.length > 0) {
    console.log("--- Uncovered Expected Skills ---");
    for (const sk of uncoveredSkills) {
      const scenarios = report.scenarios
        .filter((s) => s.expectedSkills.includes(sk))
        .map((s) => s.slug);
      console.log(`  ${sk.padEnd(25)} expected in: ${scenarios.join(", ")}`);
    }
    console.log();
  }

  // Failures
  const failures = report.scenarios.filter((s) => !s.success);
  if (failures.length > 0) {
    console.log("--- Failures ---");
    for (const f of failures) {
      console.log(`  ${f.slug}: ${f.timedOut ? "TIMEOUT" : f.error ?? "unknown error"}`);
      console.log(`    debug logs: ${f.debugLogLines} lines, stderr: ${f.stderrTraceLines} lines`);
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const runDir = flags["run-dir"] ? resolve(flags["run-dir"]) : await findLatestRunDir();
  console.log(`Analyzing: ${runDir}\n`);

  const report = await analyzeRun(runDir);

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  const MIN_COVERAGE_THRESHOLD = 50;
  const allPassed = report.passCount === report.scenarioCount;
  const coverageMet = report.coveragePercent >= MIN_COVERAGE_THRESHOLD;
  if (!coverageMet) {
    console.log(
      `\nFAILED: Coverage ${report.coveragePercent}% is below minimum threshold of ${MIN_COVERAGE_THRESHOLD}%`,
    );
  }
  process.exit(allPassed && coverageMet ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
