#!/usr/bin/env bun
/**
 * Sandbox benchmark runner: provisions Vercel Sandboxes from a snapshot,
 * runs benchmark scenarios with Claude Code + plugin, and extracts artifacts.
 *
 * Scenarios are imported from scripts/benchmark-runner.ts (no duplication).
 *
 * Usage:
 *   bun run .claude/skills/benchmark-sandbox/sandbox-runner.ts [options]
 *
 *   --snapshot-only     Create/update the base snapshot and exit
 *   --quick             Run Tier 1 only (scenarios 01, 04, 09)
 *   --scenario <slug>   Run a single scenario by slug
 *   --concurrency <n>   Max parallel sandboxes (default: 3)
 *   --timeout <ms>      Per-scenario timeout (default: 300000 = 5 min)
 *   --results-dir <p>   Override results directory
 *   --help              Print usage and exit
 */

import { Sandbox } from "@vercel/sandbox";
import { mkdir, writeFile, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { RunSummary, ScenarioSummary, SnapshotMeta } from "./types.js";
import {
  RunnerError,
  scenarioStatus,
  overallStatus,
  EXIT_ALL_PASS,
  EXIT_SOME_FAIL,
  EXIT_FATAL,
} from "./types.js";
import { Logger, type LogFormat } from "./logger.js";

// ---------------------------------------------------------------------------
// Import scenarios from the canonical source
// ---------------------------------------------------------------------------

import { PROJECTS, type BenchmarkProject } from "../../../scripts/benchmark-scenarios.js";

const SCENARIOS: BenchmarkProject[] = PROJECTS;

// Tier 1 quick-run slugs
const TIER1_SLUGS = new Set(["01-doc-qa-agent", "04-multi-model-router", "09-code-sandbox-tutor"]);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  options: {
    "snapshot-only": { type: "boolean", default: false },
    "force-snapshot": { type: "boolean", default: false },
    quick: { type: "boolean", default: false },
    scenario: { type: "string" },
    concurrency: { type: "string", default: "3" },
    timeout: { type: "string", default: "300000" },
    "results-dir": { type: "string" },
    json: { type: "boolean", default: false },
    "log-format": { type: "string", default: "human" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (flags.help) {
  console.log(`Usage: bun run .claude/skills/benchmark-sandbox/sandbox-runner.ts [options]
  --snapshot-only     Create/update the base snapshot and exit
  --force-snapshot    Force fresh snapshot creation (ignore cache)
  --quick             Run Tier 1 only (scenarios 01, 04, 09)
  --scenario <slug>   Run a single scenario by slug
  --concurrency <n>   Max parallel sandboxes (default: 3, max: 10)
  --timeout <ms>      Per-scenario timeout (default: 300000 = 5 min)
  --results-dir <p>   Override results directory
  --json              Write only RunSummary JSON to stdout (all other output → stderr)
  --log-format <fmt>  Log format: human (default) or json (NDJSON events to stderr)
  --help              Print usage

Exit codes:
  0  All scenarios passed
  1  One or more scenarios failed or timed out
  2  Fatal runner error (snapshot failure, scenario load failure, etc.)`);
  process.exit(0);
}

const JSON_MODE = flags.json!;
const LOG_FORMAT = (flags["log-format"] === "json" ? "json" : "human") as LogFormat;

// runId declared early so Logger can use it; the timestamped form is set later in main()
let runId = `run-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const logger = new Logger({ format: LOG_FORMAT, runId });

/** Shorthand — all human output goes to stderr (stdout reserved for --json RunSummary). */
const log = (msg: string) => logger.info(msg);
const warn = (msg: string) => logger.warn(msg);

const MAX_CONCURRENCY = 10;
const WARN_CONCURRENCY = 6;
const CONCURRENCY_RAW = parseInt(flags.concurrency!, 10);
if (CONCURRENCY_RAW > MAX_CONCURRENCY) {
  logger.error(`Concurrency ${CONCURRENCY_RAW} exceeds maximum of ${MAX_CONCURRENCY}. Clamping to ${MAX_CONCURRENCY}.`);
}
if (CONCURRENCY_RAW > WARN_CONCURRENCY && CONCURRENCY_RAW <= MAX_CONCURRENCY) {
  warn(`Warning: concurrency ${CONCURRENCY_RAW} exceeds ${WARN_CONCURRENCY} — may hit sandbox rate limits.`);
}
const CONCURRENCY = Math.min(Math.max(CONCURRENCY_RAW, 1), MAX_CONCURRENCY);
const TIMEOUT_MS = parseInt(flags.timeout!, 10);
const LOCAL_PLUGIN_DIR = join(homedir(), "dev", "vercel-plugin");
const SANDBOX_HOME = "/home/vercel-sandbox";
const SANDBOX_PLUGIN_DIR = `${SANDBOX_HOME}/vercel-plugin`;
const DEFAULT_RESULTS = join(homedir(), "dev", "vercel-plugin-testing", "sandbox-results");
const RESULTS_DIR = resolve(flags["results-dir"] ?? DEFAULT_RESULTS);
const SNAPSHOT_CACHE_PATH = join(DEFAULT_RESULTS, ".snapshot-cache.json");
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed(start: number): string {
  return `${((performance.now() - start) / 1000).toFixed(1)}s`;
}

function resolveApiKey(): string {
  // VERCEL_API_KEY is for sandbox provisioning, not for Claude Code
  const key =
    process.env.ANTHROPIC_API_KEY ??
    process.env.AI_GATEWAY_API_KEY;
  if (key) return key;

  // Try macOS Keychain via apiKeyHelper
  try {
    const keychainKey = execSync(
      'security find-generic-password -a "$USER" -s "ANTHROPIC_AUTH_TOKEN" -w',
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (keychainKey) return keychainKey;
  } catch { /* keychain not available or key not found */ }

  logger.error("Missing API key. Set ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY (or store in macOS Keychain as ANTHROPIC_AUTH_TOKEN)");
  process.exit(1);
}

function resolveBaseUrl(): string | undefined {
  return process.env.ANTHROPIC_BASE_URL ?? "https://ai-gateway.vercel.sh";
}

/** Essential plugin directories/files to upload into the sandbox. */
const PLUGIN_UPLOAD_DIRS = ["hooks", "skills", "generated"];
const PLUGIN_UPLOAD_FILES = ["hooks/hooks.json", "package.json"];

/**
 * Recursively collect files from a local directory, returning
 * { relativePath: fileContent } pairs suitable for sandbox.writeFiles().
 */
async function collectPluginFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  async function walkDir(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(join(LOCAL_PLUGIN_DIR, dir), { withFileTypes: true });
    for (const entry of entries) {
      const relPath = join(dir, entry.name);
      const fullPath = join(LOCAL_PLUGIN_DIR, relPath);
      if (entry.isDirectory()) {
        // Skip node_modules, .git, src (only need compiled hooks)
        if (["node_modules", ".git", "src", ".claude", "tests", "scripts", ".playground"].includes(entry.name)) continue;
        await walkDir(relPath, prefix);
      } else if (entry.isFile()) {
        // Skip .mts source files (only need compiled .mjs), test files, and large files
        if (entry.name.endsWith(".mts") || entry.name.endsWith(".test.ts")) continue;
        const s = await stat(fullPath);
        if (s.size > 200_000) continue; // skip files > 200KB
        const content = await readFile(fullPath, "utf-8");
        files[join(prefix, relPath)] = content;
      }
    }
  }

  for (const dir of PLUGIN_UPLOAD_DIRS) {
    await walkDir(dir, "");
  }

  // Also upload root-level files
  for (const f of PLUGIN_UPLOAD_FILES) {
    try {
      const content = await readFile(join(LOCAL_PLUGIN_DIR, f), "utf-8");
      files[f] = content;
    } catch { /* optional file */ }
  }

  return files;
}

/**
 * Upload the local plugin into the sandbox at SANDBOX_PLUGIN_DIR,
 * then run `npx add-plugin <sandbox-path>` to install it.
 */
async function uploadAndInstallPlugin(
  sandbox: SandboxInstance,
  projectDir: string,
): Promise<{ out: string; err: string; exit: number }> {
  const pluginFiles = await collectPluginFiles();
  const entries = Object.entries(pluginFiles);
  log(`  [plugin] Uploading ${entries.length} files to sandbox via writeFiles()...`);

  // Use native sandbox.writeFiles() API — much more reliable than heredocs
  const fileBatch = entries.map(([relPath, content]) => ({
    path: join(SANDBOX_PLUGIN_DIR, relPath),
    content: Buffer.from(content, "utf-8"),
  }));

  // Upload in chunks of 10 to avoid payload size limits
  const CHUNK_SIZE = 10;
  const totalChunks = Math.ceil(fileBatch.length / CHUNK_SIZE);
  logger.event("plugin.upload.started", { file_count: fileBatch.length, chunk_size: CHUNK_SIZE, total_chunks: totalChunks });

  for (let i = 0; i < fileBatch.length; i += CHUNK_SIZE) {
    const chunk = fileBatch.slice(i, i + CHUNK_SIZE);
    const chunkIndex = Math.floor(i / CHUNK_SIZE);
    const chunkBytes = chunk.reduce((a, f) => a + f.content.length, 0);
    try {
      await sandbox.writeFiles(chunk);
      logger.event("plugin.upload.chunk", { index: chunkIndex, total: totalChunks, bytes: chunkBytes });
    } catch (err: any) {
      logger.error(`  [plugin] writeFiles chunk ${i}-${i + chunk.length} failed: ${err.message}`);
      logger.error(`  [plugin] Paths: ${chunk.map(f => f.path).join(", ")}`);
      logger.error(`  [plugin] Total bytes: ${chunkBytes}`);
      throw err;
    }
  }
  logger.event("plugin.upload.completed", { file_count: fileBatch.length });

  // Manually write Claude Code plugin config instead of using add-plugin
  // (add-plugin calls `claude mcp add-json` which requires claude in /bin/sh PATH)
  const globalSettings = {
    extraKnownMarketplaces: {
      "vercel-plugin": {
        source: { source: "directory", path: SANDBOX_PLUGIN_DIR },
      },
    },
    enabledPlugins: { "vercel-plugin@vercel-plugin": true },
  };
  const projectSettings = {
    enabledPlugins: { "vercel-plugin@vercel-plugin": true },
  };

  log(`  [plugin] Writing plugin config manually...`);
  await sandbox.writeFiles([
    {
      path: `${SANDBOX_HOME}/.claude/settings.json`,
      content: Buffer.from(JSON.stringify(globalSettings, null, 2)),
    },
    {
      path: `${projectDir}/.claude/settings.json`,
      content: Buffer.from(JSON.stringify(projectSettings, null, 2)),
    },
  ]);

  return { out: "Plugin config written manually", err: "", exit: 0 };
}

type SandboxInstance = InstanceType<typeof Sandbox>;

async function run(
  sandbox: SandboxInstance,
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
): Promise<{ out: string; err: string; exit: number }> {
  // @vercel/sandbox runCommand does not accept `timeout` — use AbortSignal instead
  const runOpts: { signal?: AbortSignal } = {};
  if (opts?.timeout) {
    runOpts.signal = AbortSignal.timeout(opts.timeout);
  }
  try {
    const result = await sandbox.runCommand(cmd, args, runOpts);
    return {
      out: (await result.stdout()).trim(),
      err: (await result.stderr()).trim(),
      exit: (result as any).exitCode ?? 0,
    };
  } catch (err: any) {
    // runCommand throws on 400 (e.g. executable_not_found) instead of returning exit code
    const msg = err.text ?? err.message ?? String(err);
    logger.error(`  [run] Command failed: ${cmd} ${args.slice(0, 2).join(" ")}`);
    logger.error(`  [run] Error: ${msg.slice(0, 300)}`);
    return { out: "", err: msg, exit: 127 };
  }
}

// ---------------------------------------------------------------------------
// Snapshot cache
// ---------------------------------------------------------------------------

interface SnapshotCache {
  snapshotId: string;
  createdAt: string; // ISO timestamp
}

async function loadCachedSnapshot(): Promise<string | null> {
  try {
    const raw = await readFile(SNAPSHOT_CACHE_PATH, "utf-8");
    const cache: SnapshotCache = JSON.parse(raw);
    const age = Date.now() - new Date(cache.createdAt).getTime();
    if (age < SNAPSHOT_MAX_AGE_MS) {
      log(`[snapshot] Using cached snapshot ${cache.snapshotId} (age: ${(age / 3600_000).toFixed(1)}h)`);
      return cache.snapshotId;
    }
    log(`[snapshot] Cached snapshot expired (age: ${(age / 3600_000).toFixed(1)}h > 24h)`);
    return null;
  } catch {
    return null; // no cache file or invalid JSON
  }
}

async function saveCachedSnapshot(snapshotId: string): Promise<void> {
  await mkdir(join(SNAPSHOT_CACHE_PATH, ".."), { recursive: true });
  const cache: SnapshotCache = { snapshotId, createdAt: new Date().toISOString() };
  await writeFile(SNAPSHOT_CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function removeCachedSnapshot(): Promise<void> {
  try {
    await unlink(SNAPSHOT_CACHE_PATH);
  } catch { /* no cache to remove */ }
}

// ---------------------------------------------------------------------------
// Snapshot verification — boot from snapshot, run `claude --version`
// ---------------------------------------------------------------------------

async function verifySnapshot(snapshotId: string): Promise<boolean> {
  logger.event("snapshot.verify.started", { snapshot_id: snapshotId });
  let sandbox: SandboxInstance | undefined;
  try {
    sandbox = await Sandbox.create({ fromSnapshot: snapshotId, timeout: 120_000 });
    const ver = await run(sandbox, "sh", ["-c", "claude --version"], { timeout: 30_000 });
    if (ver.exit === 0 && ver.out.length > 0) {
      logger.event("snapshot.verify.succeeded", { snapshot_id: snapshotId, claude_version: ver.out.slice(0, 80) });
      return true;
    }
    logger.event("snapshot.verify.failed", { snapshot_id: snapshotId, exit: ver.exit, stderr: ver.err.slice(0, 200) });
    return false;
  } catch (err: any) {
    logger.event("snapshot.verify.failed", { snapshot_id: snapshotId, error: err.message?.slice(0, 200) ?? String(err) });
    return false;
  } finally {
    if (sandbox) {
      try { await sandbox.stop(); } catch { /* already stopped */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot creation
// ---------------------------------------------------------------------------

async function createSnapshot(): Promise<string> {
  const t0 = performance.now();
  const apiKey = resolveApiKey();
  const baseUrl = resolveBaseUrl();

  log("[snapshot] Creating base sandbox (node24)...");
  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: apiKey,
    VERCEL_PLUGIN_LOG_LEVEL: "trace",
  };
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;

  const sandbox = await Sandbox.create({ runtime: "node24", env, timeout: 900_000 });
  log(`[snapshot] Sandbox ${sandbox.sandboxId} created (${elapsed(t0)})`);

  // Install Claude Code
  log("[snapshot] Installing Claude Code...");
  const t1 = performance.now();
  const install = await run(sandbox, "sh", ["-c", "npm install -g @anthropic-ai/claude-code"]);
  if (install.exit !== 0) {
    await sandbox.stop();
    throw new Error(`Claude Code install failed: ${install.err.slice(0, 300)}`);
  }
  log(`[snapshot] Claude Code installed (${elapsed(t1)})`);

  // Symlink claude + node binaries to /usr/local/bin so /bin/sh subprocesses can find them
  await run(sandbox, "sh", [
    "-c",
    "ln -sf $(which claude) /usr/local/bin/claude && ln -sf $(which node) /usr/local/bin/node && ln -sf $(which npm) /usr/local/bin/npm && ln -sf $(which npx) /usr/local/bin/npx",
  ]);

  // Verify claude --version (use sh -c to ensure PATH resolution)
  const ver = await run(sandbox, "sh", ["-c", "claude --version"]);
  log(`[snapshot] claude version: ${ver.out}`);

  // Take snapshot
  log("[snapshot] Taking snapshot...");
  const t2 = performance.now();
  const snapshot = await sandbox.snapshot();
  const snapshotId = (snapshot as any).snapshotId ?? (snapshot as any).id ?? String(snapshot);
  log(`[snapshot] Snapshot created: ${snapshotId} (${elapsed(t2)})`);

  await sandbox.stop();
  log(`[snapshot] Total: ${elapsed(t0)}`);

  return snapshotId;
}

// ---------------------------------------------------------------------------
// Per-scenario runner
// ---------------------------------------------------------------------------

interface ScenarioResult {
  slug: string;
  sandboxId: string;
  success: boolean;
  timedOut: boolean;
  durationMs: number;
  sessionMethod: string;
  expectedSkills: string[];
  claimedSkills: string[];
  hookEvidence: {
    claimDirs: boolean;
    seenFile: boolean;
    debugLogCount: number;
    preToolUseInStderr: boolean;
    userPromptInStderr: boolean;
  };
  error?: string;
}

async function runScenario(
  project: BenchmarkProject,
  snapshotId: string,
  apiKey: string,
  baseUrl: string | undefined,
): Promise<ScenarioResult> {
  const t0 = performance.now();
  const projectDir = `${SANDBOX_HOME}/${project.slug}`;

  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: apiKey,
    VERCEL_PLUGIN_LOG_LEVEL: "trace",
  };
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;

  let sandbox: SandboxInstance | undefined;
  try {
    // Create sandbox from snapshot (snapshot has node runtime but global npm packages don't persist)
    sandbox = await Sandbox.create({ fromSnapshot: snapshotId, env, timeout: 900_000 });
    log(`  [${project.slug}] Sandbox ${sandbox.sandboxId} ready (${elapsed(t0)})`);

    // Install Claude Code (global npm packages don't survive snapshot restore)
    const claudeInstall = await run(sandbox, "sh", ["-c", "npm install -g @anthropic-ai/claude-code"]);
    const claudeBin = (await run(sandbox, "sh", ["-c", "which claude"])).out;
    log(`  [${project.slug}] Claude installed at ${claudeBin} (${elapsed(t0)})`);

    // Set up project directory and install plugin from local dev copy
    await run(sandbox, "mkdir", ["-p", projectDir]);
    await run(sandbox, "sh", ["-c", `cd ${projectDir} && npm init -y`]);

    const pluginInstall = await uploadAndInstallPlugin(sandbox, projectDir);
    log(`  [${project.slug}] add-plugin exit=${pluginInstall.exit}`);
    if (pluginInstall.out) log(`  [${project.slug}] add-plugin out: ${pluginInstall.out.slice(0, 200)}`);
    if (pluginInstall.err) log(`  [${project.slug}] add-plugin err: ${pluginInstall.err.slice(0, 200)}`);
    if (pluginInstall.exit !== 0 && !pluginInstall.out.includes("successfully") && !pluginInstall.out.includes("Installed")) {
      throw new Error(`Plugin install failed (exit ${pluginInstall.exit}): ${(pluginInstall.out + " " + pluginInstall.err).slice(0, 300)}`);
    }

    // Write prompt to a temp file to avoid shell injection from prompt content
    const promptTmpPath = "/tmp/claude-prompt.txt";
    await sandbox.writeFiles([{ path: promptTmpPath, content: Buffer.from(project.prompt, "utf-8") }]);

    // Check for PTY wrapper
    const scriptCheck = await run(sandbox, "sh", ["-c", "which script 2>/dev/null && echo FOUND || echo MISSING"]);
    const hasScript = scriptCheck.out.includes("FOUND");

    // Run Claude Code session — prompt is read from temp file via cat, never interpolated
    const settingsPath = `${projectDir}/.claude/settings.json`;
    let sessionResult: { out: string; err: string; exit: number };
    let sessionMethod: string;

    if (hasScript) {
      sessionMethod = "script-pty";
      sessionResult = await run(
        sandbox,
        "sh",
        [
          "-c",
          `cd ${projectDir} && VERCEL_PLUGIN_LOG_LEVEL=trace CLAUDE_PLUGIN_ROOT=${SANDBOX_PLUGIN_DIR} script -qec "${SANDBOX_HOME}/.global/npm/bin/claude --dangerously-skip-permissions --settings ${settingsPath} \\"\\$(cat ${promptTmpPath})\\"" /dev/null`,
        ],
        { timeout: TIMEOUT_MS },
      );
    } else {
      sessionMethod = "direct";
      sessionResult = await run(
        sandbox,
        "sh",
        [
          "-c",
          `cd ${projectDir} && VERCEL_PLUGIN_LOG_LEVEL=trace CLAUDE_PLUGIN_ROOT=${SANDBOX_PLUGIN_DIR} ${SANDBOX_HOME}/.global/npm/bin/claude --dangerously-skip-permissions --settings ${settingsPath} "$(cat ${promptTmpPath})"`,
        ],
        { timeout: TIMEOUT_MS },
      );
    }

    const timedOut = sessionResult.exit === 124; // timeout exit code

    // Extract hook evidence
    const claimCheck = await run(sandbox, "sh", [
      "-c",
      "find /tmp -maxdepth 1 -name 'vercel-plugin-*-seen-skills.d' -type d 2>/dev/null | head -5",
    ]);
    const claimDirs = claimCheck.out.split("\n").filter(Boolean);
    let claimedSkills: string[] = [];
    if (claimDirs.length > 0) {
      const contents = await run(sandbox, "sh", ["-c", `ls ${claimDirs[0]} 2>/dev/null`]);
      claimedSkills = contents.out.split("\n").filter(Boolean);
    }

    const seenFileCheck = await run(sandbox, "sh", [
      "-c",
      "find /tmp -maxdepth 1 -name 'vercel-plugin-*-seen-skills.txt' 2>/dev/null | head -1",
    ]);
    const debugLogCheck = await run(sandbox, "sh", [
      "-c",
      `find /root/.claude/debug -name '*.txt' -o -name '*.log' 2>/dev/null; find ${SANDBOX_HOME}/.claude/debug -name '*.txt' -o -name '*.log' 2>/dev/null`,
    ]);
    const debugLogFiles = debugLogCheck.out.split("\n").filter(Boolean);

    const hookEvidence = {
      claimDirs: claimDirs.length > 0,
      seenFile: seenFileCheck.out.length > 0,
      debugLogCount: debugLogFiles.length,
      preToolUseInStderr:
        sessionResult.err.includes("PreToolUse") ||
        sessionResult.err.includes("pretooluse") ||
        sessionResult.err.includes("skill-inject"),
      userPromptInStderr:
        sessionResult.err.includes("UserPromptSubmit") ||
        sessionResult.err.includes("user-prompt-submit"),
    };

    // Save artifacts to results dir
    const slugDir = join(RESULTS_DIR, runId, project.slug);
    await mkdir(slugDir, { recursive: true });
    await mkdir(join(slugDir, "claim-dir"), { recursive: true });
    await mkdir(join(slugDir, "debug-logs"), { recursive: true });

    await writeFile(join(slugDir, "claude-output.txt"), sessionResult.out);
    await writeFile(join(slugDir, "stderr-trace.txt"), sessionResult.err);

    // Copy claim dir contents
    for (const skill of claimedSkills) {
      await writeFile(join(slugDir, "claim-dir", skill), "");
    }

    // Extract seen-skills.txt
    if (seenFileCheck.out.length > 0) {
      const seenContents = await run(sandbox, "cat", [seenFileCheck.out.split("\n")[0]]);
      await writeFile(join(slugDir, "seen-skills.txt"), seenContents.out);
    }

    // Extract debug logs
    for (const logFile of debugLogFiles.slice(0, 5)) {
      try {
        const content = await run(sandbox, "sh", ["-c", `head -500 '${logFile}'`]);
        const basename = logFile.split("/").pop() ?? "unknown.txt";
        await writeFile(join(slugDir, "debug-logs", basename), content.out);
      } catch { /* skip unreadable logs */ }
    }

    // Project tree
    const tree = await run(sandbox, "sh", [
      "-c",
      `find ${projectDir} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' | head -80`,
    ]);
    await writeFile(join(slugDir, "project-tree.txt"), tree.out);

    // Run meta
    const result: ScenarioResult = {
      slug: project.slug,
      sandboxId: sandbox.sandboxId,
      success: sessionResult.exit === 0 && !timedOut,
      timedOut,
      durationMs: performance.now() - t0,
      sessionMethod,
      expectedSkills: project.expectedSkills,
      claimedSkills,
      hookEvidence,
    };
    await writeFile(join(slugDir, "run-meta.json"), JSON.stringify(result, null, 2));

    return result;
  } catch (err: any) {
    return {
      slug: project.slug,
      sandboxId: sandbox?.sandboxId ?? "unknown",
      success: false,
      timedOut: false,
      durationMs: performance.now() - t0,
      sessionMethod: "none",
      expectedSkills: project.expectedSkills,
      claimedSkills: [],
      hookEvidence: {
        claimDirs: false,
        seenFile: false,
        debugLogCount: 0,
        preToolUseInStderr: false,
        userPromptInStderr: false,
      },
      error: err.message?.slice(0, 400) ?? String(err),
    };
  } finally {
    if (sandbox) {
      try {
        await sandbox.stop();
      } catch { /* already stopped */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Parallel orchestrator
// ---------------------------------------------------------------------------

async function runParallel(
  scenarios: BenchmarkProject[],
  snapshotId: string,
  concurrency: number,
): Promise<ScenarioResult[]> {
  const apiKey = resolveApiKey();
  const baseUrl = resolveBaseUrl();
  const results: ScenarioResult[] = [];
  const queue = [...scenarios];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const project = queue.shift()!;
      log(`\n--- ${project.slug} (${scenarios.length - queue.length}/${scenarios.length}) ---`);
      const result = await runScenario(project, snapshotId, apiKey, baseUrl);
      results.push(result);

      const status = result.timedOut ? "TIMEOUT" : result.success ? "OK" : "FAIL";
      log(
        `  [${project.slug}] ${status} | skills: ${result.claimedSkills.join(", ") || "none"} | ${(result.durationMs / 1000).toFixed(1)}s`,
      );
    }
  }

  // Launch N workers
  const workers = Array.from({ length: Math.min(concurrency, scenarios.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// runId is declared at the top alongside the Logger; no re-declaration needed here.

async function main() {
  const t0 = performance.now();

  log("=== Benchmark Sandbox Runner ===\n");
  logger.event("runner.start", { mode: flags.scenario ? "single" : flags.quick ? "quick" : "full" });

  // Step 1: Create or reuse snapshot (cached for 24h, verified before use)
  let snapshotId: string | null = null;
  let snapshotCached = false;
  let snapshotAgeHours: number | undefined;
  let snapshotCreationMs: number | undefined;

  if (!flags["force-snapshot"]) {
    snapshotId = await loadCachedSnapshot();
    if (snapshotId) {
      logger.event("snapshot.cache.hit", { snapshot_id: snapshotId });
      try {
        const raw = await readFile(SNAPSHOT_CACHE_PATH, "utf-8");
        const cache = JSON.parse(raw) as SnapshotCache;
        snapshotAgeHours = (Date.now() - new Date(cache.createdAt).getTime()) / 3600_000;
      } catch { /* ignore */ }

      // Verify cached snapshot is still usable
      const verified = await verifySnapshot(snapshotId);
      if (verified) {
        snapshotCached = true;
      } else {
        // Stale — invalidate and recreate once
        const staleErr = new RunnerError(
          "SNAPSHOT_CACHE_STALE",
          `Cached snapshot ${snapshotId} failed verification`,
        );
        warn(`[snapshot] ${staleErr.message} — ${staleErr.hint}`);
        logger.event("snapshot.verify.failed", { snapshot_id: snapshotId, error_code: staleErr.code });
        await removeCachedSnapshot();
        snapshotId = null; // fall through to creation
      }
    }
  }

  if (!snapshotId) {
    // Remove stale cache before attempting creation so a failure doesn't leave one
    await removeCachedSnapshot();
    logger.event("snapshot.cache.miss", {});
    logger.event("snapshot.create.started", {});
    const snapT0 = performance.now();
    snapshotId = await createSnapshot();
    snapshotCreationMs = performance.now() - snapT0;
    logger.event("snapshot.create.succeeded", { snapshot_id: snapshotId, duration_ms: Math.round(snapshotCreationMs) });

    // Verify newly created snapshot before caching
    const newVerified = await verifySnapshot(snapshotId);
    if (!newVerified) {
      const verifyErr = new RunnerError(
        "SNAPSHOT_VERIFY_FAILED",
        `Newly created snapshot ${snapshotId} failed verification`,
      );
      logger.error(`Fatal: ${verifyErr.message}`);
      logger.error(`Hint: ${verifyErr.hint}`);
      logger.event("runner.failed", { error: verifyErr.message, error_code: verifyErr.code });
      process.exit(EXIT_FATAL);
    }

    await saveCachedSnapshot(snapshotId);
  }
  log(`\nSnapshot: ${snapshotId}\n`);

  if (flags["snapshot-only"]) {
    log("--snapshot-only: done.");
    process.exit(0);
  }

  // Step 2: Select scenarios
  let scenarios = SCENARIOS;
  if (flags.scenario) {
    const match = SCENARIOS.find((s) => s.slug === flags.scenario);
    if (!match) {
      logger.error(`Unknown scenario: ${flags.scenario}`);
      logger.error(`Available: ${SCENARIOS.map((s) => s.slug).join(", ")}`);
      process.exit(1);
    }
    scenarios = [match];
  } else if (flags.quick) {
    scenarios = SCENARIOS.filter((s) => TIER1_SLUGS.has(s.slug));
  }

  log(`Scenarios: ${scenarios.length} (${flags.quick ? "quick" : flags.scenario ?? "full"})`);
  log(`Concurrency: ${CONCURRENCY}`);
  log(`Timeout: ${TIMEOUT_MS / 1000}s per scenario`);
  log(`Results: ${RESULTS_DIR}/${runId}\n`);

  // Create results directory
  await mkdir(join(RESULTS_DIR, runId), { recursive: true });

  // Step 3: Run scenarios
  const results = await runParallel(scenarios, snapshotId, CONCURRENCY);

  // Step 4: Build RunSummary (single source of truth for both human + JSON output)
  const scenarioSummaries: ScenarioSummary[] = results.map((r) => ({
    slug: r.slug,
    sandbox_id: r.sandboxId,
    status: scenarioStatus(r),
    duration_ms: r.durationMs,
    session_method: r.sessionMethod,
    expected_skills: r.expectedSkills,
    claimed_skills: r.claimedSkills,
    hook_evidence: {
      claim_dirs: r.hookEvidence.claimDirs,
      seen_file: r.hookEvidence.seenFile,
      debug_log_count: r.hookEvidence.debugLogCount,
      pre_tool_use_in_stderr: r.hookEvidence.preToolUseInStderr,
      user_prompt_in_stderr: r.hookEvidence.userPromptInStderr,
    },
    error: r.error,
  }));

  const snapshotMeta: SnapshotMeta = {
    snapshot_id: snapshotId,
    cached: snapshotCached,
    ...(snapshotAgeHours !== undefined && { age_hours: Math.round(snapshotAgeHours * 10) / 10 }),
    ...(snapshotCreationMs !== undefined && { creation_duration_ms: Math.round(snapshotCreationMs) }),
  };

  const mode = flags.scenario ? "single" as const : flags.quick ? "quick" as const : "full" as const;

  const summary: RunSummary = {
    schema_version: 1,
    run_id: runId,
    status: overallStatus(scenarioSummaries),
    timestamp: new Date().toISOString(),
    snapshot: snapshotMeta,
    scenarios: scenarioSummaries,
    timing: {
      total_duration_ms: Math.round(performance.now() - t0),
      scenario_durations_ms: Object.fromEntries(
        scenarioSummaries.map((s) => [s.slug, Math.round(s.duration_ms)]),
      ),
    },
    config: {
      concurrency: CONCURRENCY,
      timeout_ms: TIMEOUT_MS,
      results_dir: join(RESULTS_DIR, runId),
      mode,
    },
  };

  // Write manifest (always, regardless of --json)
  await writeFile(join(RESULTS_DIR, runId, "run-manifest.json"), JSON.stringify(summary, null, 2));

  // Step 5: Print human summary table (derived from RunSummary)
  log("\n=== Summary ===");
  log(
    `${"Slug".padEnd(28)} ${"Status".padEnd(10)} ${"Method".padEnd(12)} ${"Skills".padEnd(30)} Duration`,
  );
  log("-".repeat(100));
  for (const s of summary.scenarios) {
    const dur = `${(s.duration_ms / 1000).toFixed(1)}s`;
    const skills = s.claimed_skills.join(", ") || "(none)";
    log(`${s.slug.padEnd(28)} ${s.status.toUpperCase().padEnd(10)} ${s.session_method.padEnd(12)} ${skills.padEnd(30)} ${dur}`);
  }

  const passed = summary.scenarios.filter((s) => s.status === "pass").length;
  const hookFired = summary.scenarios.filter(
    (s) => s.hook_evidence.claim_dirs || s.hook_evidence.pre_tool_use_in_stderr,
  ).length;
  log(`\n${passed}/${summary.scenarios.length} scenarios succeeded`);
  log(`${hookFired}/${summary.scenarios.length} scenarios had hook evidence`);
  log(`Results: ${summary.config.results_dir}`);
  log(`Total time: ${elapsed(t0)}\n`);

  // --json: write only RunSummary to stdout (everything else already went to stderr)
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  }

  // Exit codes: 0=all pass, 1=some fail, 2=fatal
  logger.event("runner.completed", { status: summary.status, scenarios: summary.scenarios.length });
  const exitCode = summary.status === "pass" ? EXIT_ALL_PASS : EXIT_SOME_FAIL;
  process.exit(exitCode);
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message ?? err}`);
  logger.event("runner.failed", { error: err.message ?? String(err) });
  process.exit(EXIT_FATAL);
});
