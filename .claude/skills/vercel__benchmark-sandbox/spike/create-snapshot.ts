#!/usr/bin/env bun
/**
 * Create a pre-baked Vercel Sandbox snapshot with Claude Code + vercel-plugin
 * pre-installed. New sandboxes from this snapshot start in seconds instead of
 * waiting for fresh installs each time.
 *
 * Acceptance criteria:
 *  1. Snapshot includes Claude Code globally installed
 *  2. Snapshot includes vercel-plugin (hooks.json + settings) in a template dir
 *  3. New sandbox from snapshot starts in under 10 seconds
 *  4. `claude --version` passes on snapshot-based sandbox
 *  5. Hook verification (hooks.json present) passes on snapshot-based sandbox
 *  6. Snapshot ID is exported (stdout JSON + optional file) for sandbox-runner.ts
 *
 * Usage:
 *   bun run .claude/skills/benchmark-sandbox/spike/create-snapshot.ts [options]
 *
 *   --output <path>   Write snapshot metadata JSON to file (default: stdout only)
 *   --verify          Create a second sandbox from the snapshot and verify it
 *   --help            Print usage and exit
 */

import { Sandbox } from "@vercel/sandbox";
import { writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// ── CLI ──────────────────────────────────────────────────────────────

const { values: flags } = parseArgs({
  options: {
    output: { type: "string" },
    verify: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (flags.help) {
  console.log(`Usage: bun run .claude/skills/benchmark-sandbox/spike/create-snapshot.ts [options]
  --output <path>   Write snapshot metadata JSON to file
  --verify          Verify the snapshot by booting a sandbox from it
  --help            Print usage`);
  process.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveApiKey(): string {
  const key =
    process.env.ANTHROPIC_API_KEY ??
    process.env.AI_GATEWAY_API_KEY ??
    process.env.VERCEL_API_KEY;
  if (key) return key;

  // Try macOS Keychain via apiKeyHelper
  try {
    const keychainKey = execSync(
      'security find-generic-password -a "$USER" -s "ANTHROPIC_AUTH_TOKEN" -w',
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (keychainKey) return keychainKey;
  } catch { /* keychain not available or key not found */ }

  console.error(
    "Missing API key. Set one of: ANTHROPIC_API_KEY, AI_GATEWAY_API_KEY, VERCEL_API_KEY (or store in macOS Keychain as ANTHROPIC_AUTH_TOKEN)",
  );
  process.exit(1);
}

function resolveBaseUrl(): string | undefined {
  return process.env.ANTHROPIC_BASE_URL ?? "https://ai-gateway.vercel.sh";
}

function elapsed(start: number): string {
  return `${((performance.now() - start) / 1000).toFixed(1)}s`;
}

type SandboxInstance = InstanceType<typeof Sandbox>;

async function run(
  sandbox: SandboxInstance,
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
): Promise<{ out: string; err: string; exit: number }> {
  const result = await sandbox.runCommand(cmd, args, opts);
  return {
    out: (await result.stdout()).trim(),
    err: (await result.stderr()).trim(),
    exit: (result as any).exitCode ?? 0,
  };
}

const LOCAL_PLUGIN_DIR = join(homedir(), "dev", "vercel-plugin");
const SANDBOX_PLUGIN_DIR = "/home/vercel-sandbox/vercel-plugin";
// Template directory inside the snapshot where plugin config lives.
// sandbox-runner copies from here into each project dir for fast setup.
const TEMPLATE_DIR = "/home/vercel-sandbox/.vercel-plugin-template";

/** Essential plugin directories to upload into the sandbox. */
const PLUGIN_UPLOAD_DIRS = ["hooks", "skills", "generated"];

async function collectPluginFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  async function walkDir(dir: string): Promise<void> {
    const entries = await readdir(join(LOCAL_PLUGIN_DIR, dir), { withFileTypes: true });
    for (const entry of entries) {
      const relPath = join(dir, entry.name);
      const fullPath = join(LOCAL_PLUGIN_DIR, relPath);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "src", ".claude", "tests", "scripts", ".playground"].includes(entry.name)) continue;
        await walkDir(relPath);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".mts") || entry.name.endsWith(".test.ts")) continue;
        const s = await stat(fullPath);
        if (s.size > 200_000) continue;
        const content = await readFile(fullPath, "utf-8");
        files[relPath] = content;
      }
    }
  }

  for (const dir of PLUGIN_UPLOAD_DIRS) {
    await walkDir(dir);
  }

  // Root-level files
  for (const f of ["hooks/hooks.json", "package.json"]) {
    try {
      const content = await readFile(join(LOCAL_PLUGIN_DIR, f), "utf-8");
      files[f] = content;
    } catch { /* optional */ }
  }

  return files;
}

async function uploadPluginToSandbox(sandbox: InstanceType<typeof Sandbox>): Promise<void> {
  const pluginFiles = await collectPluginFiles();
  console.log(`[snapshot] Uploading ${Object.keys(pluginFiles).length} plugin files to sandbox...`);

  await run(sandbox, "mkdir", ["-p", SANDBOX_PLUGIN_DIR]);
  for (const [relPath, content] of Object.entries(pluginFiles)) {
    const sandboxPath = join(SANDBOX_PLUGIN_DIR, relPath);
    const dir = sandboxPath.split("/").slice(0, -1).join("/");
    await run(sandbox, "mkdir", ["-p", dir]);
    await run(sandbox, "sh", ["-c", `cat > '${sandboxPath}' << 'PLUGIN_EOF'\n${content}\nPLUGIN_EOF`]);
  }
}

// ── Snapshot creation ────────────────────────────────────────────────

interface SnapshotMetadata {
  snapshotId: string;
  claudeVersion: string;
  pluginInstalled: boolean;
  templateDir: string;
  createdAt: string;
  createDurationMs: number;
}

async function createSnapshot(): Promise<SnapshotMetadata> {
  const t0 = performance.now();
  const apiKey = resolveApiKey();
  const baseUrl = resolveBaseUrl();

  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: apiKey,
    VERCEL_PLUGIN_LOG_LEVEL: "trace",
  };
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;

  // Step 1: Create base sandbox
  console.log("[snapshot] Creating base sandbox (node24)...");
  const t1 = performance.now();
  const sandbox = await Sandbox.create({ runtime: "node24", env });
  console.log(`[snapshot] Sandbox ${sandbox.sandboxId} created (${elapsed(t1)})`);

  try {
    // Step 2: Install Claude Code globally
    console.log("[snapshot] Installing Claude Code...");
    const t2 = performance.now();
    const install = await run(sandbox, "npm", [
      "install",
      "-g",
      "@anthropic-ai/claude-code",
    ]);
    if (install.exit !== 0) {
      throw new Error(`Claude Code install failed (exit=${install.exit}): ${install.err.slice(0, 300)}`);
    }
    console.log(`[snapshot] Claude Code installed (${elapsed(t2)})`);

    // Step 3: Verify claude --version
    const ver = await run(sandbox, "claude", ["--version"]);
    if (!/\d+\.\d+/.test(ver.out)) {
      throw new Error(`claude --version returned unexpected output: ${ver.out}`);
    }
    console.log(`[snapshot] claude version: ${ver.out}`);

    // Step 4: Upload local plugin and install into a template directory.
    // This uses the local development version instead of fetching from GitHub.
    console.log("[snapshot] Uploading local plugin and installing into template dir...");
    const t4 = performance.now();
    await uploadPluginToSandbox(sandbox);
    await run(sandbox, "mkdir", ["-p", TEMPLATE_DIR]);
    await run(sandbox, "sh", ["-c", `cd ${TEMPLATE_DIR} && npm init -y`]);
    const pluginInstall = await run(sandbox, "sh", [
      "-c",
      `cd ${TEMPLATE_DIR} && npx -y add-plugin ${SANDBOX_PLUGIN_DIR} -s project -y`,
    ]);
    const pluginOk =
      pluginInstall.exit === 0 ||
      pluginInstall.out.includes("successfully") ||
      pluginInstall.out.includes("added");
    if (!pluginOk) {
      throw new Error(`Plugin install failed: ${pluginInstall.out.slice(0, 300)}`);
    }
    console.log(`[snapshot] Plugin installed into template (${elapsed(t4)})`);

    // Verify hooks.json exists in the template
    const hooksCheck = await run(sandbox, "sh", [
      "-c",
      `test -f ${TEMPLATE_DIR}/.claude/hooks.json && echo EXISTS || echo MISSING`,
    ]);
    if (!hooksCheck.out.includes("EXISTS")) {
      throw new Error(`hooks.json not found in template dir after plugin install`);
    }
    console.log("[snapshot] hooks.json verified in template");

    // Verify settings.json exists
    const settingsCheck = await run(sandbox, "sh", [
      "-c",
      `test -f ${TEMPLATE_DIR}/.claude/settings.json && echo EXISTS || echo MISSING`,
    ]);
    console.log(`[snapshot] settings.json: ${settingsCheck.out}`);

    // Step 5: Take snapshot
    console.log("[snapshot] Taking snapshot...");
    const t5 = performance.now();
    const snapshot = await sandbox.snapshot();
    const snapshotId =
      (snapshot as any).snapshotId ?? (snapshot as any).id ?? String(snapshot);
    console.log(`[snapshot] Snapshot created: ${snapshotId} (${elapsed(t5)})`);

    const metadata: SnapshotMetadata = {
      snapshotId,
      claudeVersion: ver.out,
      pluginInstalled: true,
      templateDir: TEMPLATE_DIR,
      createdAt: new Date().toISOString(),
      createDurationMs: performance.now() - t0,
    };

    return metadata;
  } finally {
    try {
      await sandbox.stop();
      console.log("[snapshot] Base sandbox stopped");
    } catch {
      /* already stopped */
    }
  }
}

// ── Verification ─────────────────────────────────────────────────────

interface VerifyResult {
  bootDurationMs: number;
  claudeVersionOk: boolean;
  claudeVersion: string;
  hooksJsonPresent: boolean;
  settingsJsonPresent: boolean;
  templateDirPresent: boolean;
}

async function verifySnapshot(snapshotId: string): Promise<VerifyResult> {
  const apiKey = resolveApiKey();
  const baseUrl = resolveBaseUrl();
  const env: Record<string, string> = { ANTHROPIC_API_KEY: apiKey };
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;

  console.log("\n[verify] Booting sandbox from snapshot...");
  const tBoot = performance.now();
  const sandbox = await Sandbox.create({ fromSnapshot: snapshotId, env });
  const bootMs = performance.now() - tBoot;
  console.log(`[verify] Sandbox ${sandbox.sandboxId} booted in ${(bootMs / 1000).toFixed(1)}s`);

  try {
    // Check claude --version
    const ver = await run(sandbox, "claude", ["--version"]);
    const claudeVersionOk = /\d+\.\d+/.test(ver.out);
    console.log(`[verify] claude --version: ${ver.out} (${claudeVersionOk ? "OK" : "FAIL"})`);

    // Check hooks.json in template
    const hooksCheck = await run(sandbox, "sh", [
      "-c",
      `test -f ${TEMPLATE_DIR}/.claude/hooks.json && echo EXISTS || echo MISSING`,
    ]);
    const hooksJsonPresent = hooksCheck.out.includes("EXISTS");
    console.log(`[verify] hooks.json: ${hooksCheck.out}`);

    // Check settings.json in template
    const settingsCheck = await run(sandbox, "sh", [
      "-c",
      `test -f ${TEMPLATE_DIR}/.claude/settings.json && echo EXISTS || echo MISSING`,
    ]);
    const settingsJsonPresent = settingsCheck.out.includes("EXISTS");
    console.log(`[verify] settings.json: ${settingsCheck.out}`);

    // Check template dir exists with content
    const templateCheck = await run(sandbox, "sh", [
      "-c",
      `test -d ${TEMPLATE_DIR}/.claude && echo EXISTS || echo MISSING`,
    ]);
    const templateDirPresent = templateCheck.out.includes("EXISTS");
    console.log(`[verify] template dir (.claude): ${templateCheck.out}`);

    // Boot time check
    const bootUnder10s = bootMs < 10_000;
    console.log(
      `[verify] Boot time: ${(bootMs / 1000).toFixed(1)}s (${bootUnder10s ? "UNDER 10s" : "OVER 10s"})`,
    );

    return {
      bootDurationMs: bootMs,
      claudeVersionOk,
      claudeVersion: ver.out,
      hooksJsonPresent,
      settingsJsonPresent,
      templateDirPresent,
    };
  } finally {
    try {
      await sandbox.stop();
      console.log("[verify] Verification sandbox stopped");
    } catch {
      /* already stopped */
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const t0 = performance.now();
  console.log("=== Snapshot Creator ===\n");

  // Create snapshot
  const metadata = await createSnapshot();
  console.log(`\n[result] Snapshot ID: ${metadata.snapshotId}`);
  console.log(`[result] Claude version: ${metadata.claudeVersion}`);
  console.log(`[result] Plugin pre-installed: ${metadata.pluginInstalled}`);
  console.log(`[result] Template dir: ${metadata.templateDir}`);
  console.log(`[result] Create time: ${(metadata.createDurationMs / 1000).toFixed(1)}s`);

  // Optionally verify
  let verification: VerifyResult | undefined;
  if (flags.verify) {
    verification = await verifySnapshot(metadata.snapshotId);
  }

  // Build output JSON
  const output = {
    ...metadata,
    ...(verification
      ? {
          verification: {
            bootDurationMs: verification.bootDurationMs,
            bootUnder10s: verification.bootDurationMs < 10_000,
            claudeVersionOk: verification.claudeVersionOk,
            hooksJsonPresent: verification.hooksJsonPresent,
            settingsJsonPresent: verification.settingsJsonPresent,
            templateDirPresent: verification.templateDirPresent,
          },
        }
      : {}),
  };

  // Write to file if requested
  if (flags.output) {
    await writeFile(flags.output, JSON.stringify(output, null, 2));
    console.log(`\n[output] Metadata written to ${flags.output}`);
  }

  // Always print JSON to stdout for piping
  console.log("\n" + JSON.stringify(output, null, 2));

  // Summary
  console.log("\n" + "=".repeat(60));
  const allOk =
    metadata.pluginInstalled &&
    /\d+\.\d+/.test(metadata.claudeVersion) &&
    (!verification ||
      (verification.claudeVersionOk &&
        verification.hooksJsonPresent &&
        verification.bootDurationMs < 10_000));

  if (allOk) {
    console.log("ALL CHECKS PASSED");
  } else {
    console.log("SOME CHECKS FAILED");
  }
  console.log("=".repeat(60));
  console.log(`Total time: ${elapsed(t0)}`);

  // Export-friendly: print just the snapshot ID on the last line for easy capture
  // e.g. SNAPSHOT_ID=$(bun run create-snapshot.ts 2>/dev/null | tail -1)
  console.log(`\nSNAPSHOT_ID=${metadata.snapshotId}`);

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
