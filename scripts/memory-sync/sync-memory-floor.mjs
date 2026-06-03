#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  buildConfig,
  buildMemoryPayload,
  duplicateCandidates,
  finish,
  groupRowsByFileName,
  listMarkdownFiles,
  loadPriorityMap,
  parseArgs,
  readRecentMemoryFiles,
  validateConfig,
} from "./lib.mjs";

const report = {
  ok: true,
  mode: "floor-audit",
  scanned_local: 0,
  scanned_remote: 0,
  local_only: [],
  remote_only: [],
  present_in_both: [],
  duplicate_candidates: [],
  priority_counts: {},
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
  const configErrors = validateConfig(config, { requireMemoryDir: true });
  if (configErrors.length) {
    report.ok = false;
    report.errors.push(...configErrors.map((type) => ({ type })));
    finish(report, 2);
  }

  try {
    const priorityMap = loadPriorityMap(config);
    const files = listMarkdownFiles(config.memoryDir);
    const remoteRows = await readRecentMemoryFiles(config);
    const remoteGroups = groupRowsByFileName(remoteRows);
    const localNames = new Set(files);
    const remoteNames = new Set(remoteGroups.keys());

    report.scanned_local = files.length;
    report.scanned_remote = remoteRows.length;
    report.duplicate_candidates = duplicateCandidates(remoteRows);

    for (const fileName of files) {
      const raw = fs.readFileSync(path.join(config.memoryDir, fileName), "utf8");
      const payload = buildMemoryPayload(fileName, raw, priorityMap);
      const priority = String(payload.metadata.priority);
      report.priority_counts[priority] = (report.priority_counts[priority] || 0) + 1;

      if (remoteNames.has(fileName)) report.present_in_both.push(fileName);
      else report.local_only.push(fileName);
    }

    for (const fileName of remoteNames) {
      if (!localNames.has(fileName)) report.remote_only.push(fileName);
    }
  } catch (error) {
    report.ok = false;
    report.errors.push({ type: "runtime_error", message: error.message });
  }

  finish(report);
}

main();
