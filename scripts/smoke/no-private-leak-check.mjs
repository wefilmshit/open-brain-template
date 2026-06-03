#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const extraPatterns = (process.env.PRIVATE_LEAK_PATTERNS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const defaultPatterns = [
  String.raw`/Users/[A-Za-z0-9._-]+`,
  String.raw`BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY`,
  String.raw`service[_ -]?role[^\\n]{0,40}(key|token|secret)\\s*[:=]`,
  String.raw`Bearer [A-Za-z0-9._-]{20,}`,
  String.raw`sk-[A-Za-z0-9_-]{20,}`,
  String.raw`eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}`,
];

const patterns = [...defaultPatterns, ...extraPatterns].map((pattern) => ({
  source: pattern,
  regex: new RegExp(pattern, "i"),
}));

const ignoredDirs = new Set([".git", "node_modules", "dist", "build", ".next", ".vercel"]);
const ignoredFiles = new Set(["scripts/smoke/no-private-leak-check.mjs"]);
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".txt",
  ".yml",
  ".yaml",
]);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) files.push(...walk(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (ignoredFiles.has(relative)) continue;
    if (textExtensions.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

const findings = [];

for (const file of walk(root)) {
  const relative = path.relative(root, file);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      if (pattern.regex.test(line)) {
        findings.push({
          file: relative,
          line: index + 1,
          pattern: pattern.source,
          excerpt: line.slice(0, 180),
        });
      }
    }
  });
}

console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
process.exit(findings.length === 0 ? 0 : 1);
