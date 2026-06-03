#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  buildConfig,
  buildMemoryPayload,
  deleteRow,
  duplicateCandidates,
  finish,
  groupRowsByFileName,
  listMarkdownFiles,
  loadPriorityMap,
  parseArgs,
  readRecentMemoryFiles,
  validateConfig,
  writeMemoryFileRow,
} from "./lib.mjs";

const report = {
  ok: true,
  mode: "push",
  dry_run: false,
  scanned: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  duplicate_candidates: [],
  deleted_duplicates: 0,
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
  const configErrors = validateConfig(config, { requireMemoryDir: true });
  if (configErrors.length) {
    report.ok = false;
    report.errors.push(...configErrors.map((type) => ({ type })));
    finish(report, 2);
  }

  try {
    const priorityMap = loadPriorityMap(config);
    const remoteRows = await readRecentMemoryFiles(config);
    const grouped = groupRowsByFileName(remoteRows);
    report.duplicate_candidates = duplicateCandidates(remoteRows);

    const files = listMarkdownFiles(config.memoryDir);
    report.scanned = files.length;

    for (const fileName of files) {
      const raw = fs.readFileSync(path.join(config.memoryDir, fileName), "utf8");
      const payload = buildMemoryPayload(fileName, raw, priorityMap);
      const group = grouped.get(fileName) || [];
      const existing = group[0] || null;
      const action = existing ? "update" : "create";
      report.planned.push({
        file_name: fileName,
        action,
        remote_id: existing?.id || null,
        priority: payload.metadata.priority,
      });
      if (config.dryRun) continue;

      await writeMemoryFileRow(config, existing, payload);
      if (existing) report.updated += 1;
      else report.created += 1;

      if (config.deleteDuplicates && group.length > 1) {
        for (const duplicate of group.slice(1)) {
          if (!duplicate.id) continue;
          await deleteRow(config, duplicate.id);
          report.deleted_duplicates += 1;
        }
      }
    }
  } catch (error) {
    report.ok = false;
    report.errors.push({ type: "runtime_error", message: error.message });
  }

  finish(report);
}

main();
