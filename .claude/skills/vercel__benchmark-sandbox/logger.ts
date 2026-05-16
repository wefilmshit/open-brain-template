/**
 * Structured logger for the sandbox benchmark runner.
 *
 * Supports two output formats:
 * - "human" (default): timestamped human-readable lines → stderr
 * - "json": NDJSON RunnerEvent objects → stderr
 *
 * All log output goes to stderr so that --json mode can keep stdout clean
 * for the final RunSummary.
 *
 * API keys are automatically redacted from all output.
 */

import type { RunnerEvent, RunnerEventName } from "./types.js";

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

/** Patterns that look like API keys (sk-ant-*, anthropic key prefixes, long hex strings preceded by key-like env var names). */
const SECRET_PATTERNS = [
  // Anthropic keys: sk-ant-api03-... or sk-...
  /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g,
  /\bsk-[a-zA-Z0-9_-]{40,}\b/g,
  // Generic long bearer/api tokens following common env var assignments
  /(?<=(?:API_KEY|AUTH_TOKEN|SECRET|ANTHROPIC_API_KEY|AI_GATEWAY_API_KEY)\s*[=:]\s*)[^\s"']{20,}/gi,
];

export function redact(input: string): string {
  let result = input;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export type LogFormat = "human" | "json";

export interface LoggerOptions {
  format: LogFormat;
  runId: string;
}

export class Logger {
  private readonly format: LogFormat;
  private readonly runId: string;

  constructor(opts: LoggerOptions) {
    this.format = opts.format;
    this.runId = opts.runId;
  }

  /** Informational message (human) or structured event (json). */
  info(message: string): void {
    this.write("info", message);
  }

  /** Warning message. */
  warn(message: string): void {
    this.write("warn", message);
  }

  /** Error message. */
  error(message: string): void {
    this.write("error", message);
  }

  /**
   * Emit a structured RunnerEvent. In human mode this prints a readable line;
   * in json mode it writes a single NDJSON line.
   */
  event(name: RunnerEventName, payload: Record<string, unknown> = {}): void {
    if (this.format === "json") {
      const ev: RunnerEvent = {
        schema_version: 1,
        run_id: this.runId,
        event: name,
        timestamp: new Date().toISOString(),
        payload: this.redactPayload(payload),
      };
      process.stderr.write(JSON.stringify(ev) + "\n");
    } else {
      const payloadStr = Object.keys(payload).length > 0
        ? " " + Object.entries(payload).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")
        : "";
      this.write("event", `[${name}]${payloadStr}`);
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private write(level: string, message: string): void {
    const safe = redact(message);
    if (this.format === "json") {
      // In json mode, non-event messages are still human-readable on stderr
      // but prefixed with level for easy filtering
      process.stderr.write(`${this.timestamp()} [${level}] ${safe}\n`);
    } else {
      process.stderr.write(`${this.timestamp()} ${safe}\n`);
    }
  }

  private timestamp(): string {
    const now = new Date();
    return now.toISOString().slice(11, 23); // HH:mm:ss.SSS
  }

  private redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === "string") {
        result[key] = redact(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}
