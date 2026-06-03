#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  buildConfig,
  duplicateCandidates,
  finish,
  frontmatterForRow,
  groupRowsByFileName,
  parseArgs,
  readRecentMemoryFiles,
  validateConfig,
} from "./lib.mjs";

const report = {
  ok: true,
  mode: "pull",
  dry_run: false,
  scanned: 0,
  written: 0,
  skipped_duplicate_rows: 0,
  duplicate_candidates: [],
  planned: [],
  errors: [],
};

async function main() {
  let args;
  try {
    args = parseArgs();
  } catch (error) {
    report.ok = false;
    report.errors.push({ type: "argument_error", message: error.message });
    finish(report, 2);
  }

  const config = buildConfig(args);
  report.dry_run = config.dryRun;
  const configErrors = validateConfig(config);
  if (configErrors.length) {
    report.ok = false;
    report.errors.push(...configErrors.map((type) => ({ type })));
    finish(report, 2);
  }

  try {
    const rows = await readRecentMemoryFiles(config);
    const groups = groupRowsByFileName(rows);
    report.duplicate_candidates = duplicateCandidates(rows);
    report.scanned = rows.length;

    for (const [fileName, group] of groups.entries()) {
      const row = group[0];
      const target = path.join(config.memoryDir, fileName);
      report.planned.push({
        file_name: fileName,
        action: "write",
        remote_id: row.id || null,
        duplicate_remote_ids: group.slice(1).map((item) => item.id).filter(Boolean),
      });
      report.skipped_duplicate_rows += Math.max(0, group.length - 1);
      if (config.dryRun) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, frontmatterForRow(row), "utf8");
      report.written += 1;
    }
  } catch (error) {
    report.ok = false;
    report.errors.push({ type: "runtime_error", message: error.message });
  }

  finish(report);
}

main();
