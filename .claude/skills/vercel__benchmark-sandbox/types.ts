/**
 * Stable contracts for the sandbox benchmark runner.
 *
 * schema_version tracks breaking changes. Consumers should check this field
 * and reject unknown versions rather than silently misinterpreting data.
 */

// ---------------------------------------------------------------------------
// RunnerEvent — structured NDJSON log entries (stderr when --log-format json)
// ---------------------------------------------------------------------------

export const RUNNER_EVENT_NAMES = [
  "runner.start",
  "runner.completed",
  "runner.failed",
  "snapshot.cache.hit",
  "snapshot.cache.miss",
  "snapshot.create.started",
  "snapshot.create.succeeded",
  "snapshot.verify.started",
  "snapshot.verify.succeeded",
  "snapshot.verify.failed",
  "plugin.upload.started",
  "plugin.upload.chunk",
  "plugin.upload.completed",
  "scenario.start",
  "scenario.completed",
  "scenario.command.failed",
  "scenario.timeout",
  "artifact.extract.succeeded",
  "artifact.extract.failed",
] as const;

export type RunnerEventName = (typeof RUNNER_EVENT_NAMES)[number];

export interface RunnerEvent {
  schema_version: 1;
  run_id: string;
  event: RunnerEventName;
  timestamp: string; // ISO 8601
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// RunSummary — final machine-readable output (stdout when --json)
// ---------------------------------------------------------------------------

export type RunStatus = "pass" | "fail" | "timeout" | "error";

export interface ScenarioSummary {
  slug: string;
  sandbox_id: string;
  status: RunStatus;
  duration_ms: number;
  session_method: string;
  expected_skills: string[];
  claimed_skills: string[];
  hook_evidence: {
    claim_dirs: boolean;
    seen_file: boolean;
    debug_log_count: number;
    pre_tool_use_in_stderr: boolean;
    user_prompt_in_stderr: boolean;
  };
  error?: string;
}

export interface SnapshotMeta {
  snapshot_id: string;
  cached: boolean;
  age_hours?: number;
  creation_duration_ms?: number;
}

export interface RunSummary {
  schema_version: 1;
  run_id: string;
  status: RunStatus;
  timestamp: string; // ISO 8601
  snapshot: SnapshotMeta;
  scenarios: ScenarioSummary[];
  timing: {
    total_duration_ms: number;
    scenario_durations_ms: Record<string, number>;
  };
  config: {
    concurrency: number;
    timeout_ms: number;
    results_dir: string;
    mode: "full" | "quick" | "single";
  };
}

// ---------------------------------------------------------------------------
// RunnerError — typed error model with actionable hints
// ---------------------------------------------------------------------------

export const RUNNER_ERROR_CODES = [
  "SNAPSHOT_CACHE_STALE",
  "SNAPSHOT_VERIFY_FAILED",
  "PLUGIN_UPLOAD_CHUNK_FAILED",
  "SANDBOX_PATH_UNRESOLVED",
  "SCENARIO_LOAD_FAILED",
] as const;

export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

const ERROR_HINTS: Record<RunnerErrorCode, string> = {
  SNAPSHOT_CACHE_STALE:
    "Run with --force-snapshot to recreate the base snapshot.",
  SNAPSHOT_VERIFY_FAILED:
    "The cached snapshot may be corrupted. Delete the cache file and retry.",
  PLUGIN_UPLOAD_CHUNK_FAILED:
    "Sandbox writeFiles() failed for a chunk. Check sandbox API limits or retry.",
  SANDBOX_PATH_UNRESOLVED:
    "A sandbox path could not be resolved. Verify SANDBOX_PLUGIN_DIR and project directory.",
  SCENARIO_LOAD_FAILED:
    "Scenarios could not be loaded. Ensure scripts/benchmark-scenarios.js exists or benchmark-runner.ts is parseable.",
};

const ERROR_RETRYABLE: Record<RunnerErrorCode, boolean> = {
  SNAPSHOT_CACHE_STALE: true,
  SNAPSHOT_VERIFY_FAILED: true,
  PLUGIN_UPLOAD_CHUNK_FAILED: true,
  SANDBOX_PATH_UNRESOLVED: false,
  SCENARIO_LOAD_FAILED: false,
};

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  readonly hint: string;
  readonly retryable: boolean;
  readonly cause?: Error;

  constructor(code: RunnerErrorCode, message: string, cause?: Error) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.hint = ERROR_HINTS[code];
    this.retryable = ERROR_RETRYABLE[code];
    this.cause = cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      retryable: this.retryable,
      cause: this.cause?.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

/** Exit 0: all scenarios passed */
export const EXIT_ALL_PASS = 0;
/** Exit 1: one or more scenarios failed/timed out */
export const EXIT_SOME_FAIL = 1;
/** Exit 2: fatal runner error (snapshot failure, scenario load failure, etc.) */
export const EXIT_FATAL = 2;

// ---------------------------------------------------------------------------
// Helpers to convert internal ScenarioResult → ScenarioSummary
// ---------------------------------------------------------------------------

export function scenarioStatus(result: {
  success: boolean;
  timedOut: boolean;
  error?: string;
}): RunStatus {
  if (result.timedOut) return "timeout";
  if (result.error) return "error";
  if (result.success) return "pass";
  return "fail";
}

export function overallStatus(scenarios: ScenarioSummary[]): RunStatus {
  if (scenarios.some((s) => s.status === "error")) return "error";
  if (scenarios.every((s) => s.status === "pass")) return "pass";
  if (scenarios.some((s) => s.status === "timeout")) return "timeout";
  return "fail";
}
