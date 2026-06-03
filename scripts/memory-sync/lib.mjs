import fs from "node:fs";
import path from "node:path";

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${raw}`);
    }
    const [name, inlineValue] = raw.slice(2).split("=", 2);
    if (["dry-run", "delete-duplicates", "apply-duplicate-cleanup"].includes(name)) {
      args[toCamel(name)] = true;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    args[toCamel(name)] = value;
    if (inlineValue === undefined) index += 1;
  }
  return args;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function buildConfig(args) {
  const memoryDir = args.memoryDir || process.env.MEMORY_FILES_DIR || "memory";
  return {
    apiUrl: args.apiUrl || process.env.MEMORY_API_URL || "",
    apiKey: args.apiKey || process.env.MEMORY_API_KEY || "",
    memoryDir,
    priorityMapPath: args.priorityMap || process.env.MEMORY_PRIORITY_MAP || "",
    dryRun: Boolean(args.dryRun),
    deleteDuplicates: Boolean(args.deleteDuplicates || args.applyDuplicateCleanup),
    mockRecentFile: args.mockRecentFile || process.env.MEMORY_SYNC_MOCK_RECENT_FILE || "",
  };
}

export function validateConfig(config, { requireMemoryDir = false } = {}) {
  const errors = [];
  if (!config.apiUrl) errors.push("missing_api_url");
  if (!config.apiKey) errors.push("missing_api_key");
  if (config.apiUrl) {
    try {
      const parsed = new URL(config.apiUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) errors.push("bad_url_protocol");
    } catch {
      errors.push("bad_url");
    }
  }
  if (requireMemoryDir && !fs.existsSync(config.memoryDir)) errors.push("missing_memory_dir");
  return errors;
}

export function finish(report, code = report.ok ? 0 : 1) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(code);
}

export function loadPriorityMap(config) {
  if (!config.priorityMapPath) return {};
  try {
    return JSON.parse(fs.readFileSync(config.priorityMapPath, "utf8"));
  } catch (error) {
    throw new Error(`priority_map_error: ${error.message}`);
  }
}

export function listMarkdownFiles(memoryDir) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.relative(memoryDir, full).split(path.sep).join("/"));
      }
    }
  }
  walk(memoryDir);
  return files.sort((a, b) => {
    if (a === "MEMORY.md") return -1;
    if (b === "MEMORY.md") return 1;
    return a.localeCompare(b);
  });
}

export function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: raw.trim() };
  }
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const row = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!row) continue;
    meta[row[1]] = row[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return { meta, body: match[2].trim() };
}

export function buildMemoryPayload(fileName, raw, priorityMap = {}) {
  const { meta, body } = parseFrontmatter(raw);
  const mapped = priorityMap[fileName];
  const mappedPriority = typeof mapped === "object" ? mapped.priority : mapped;
  const priority = parsePriority(meta.priority ?? mappedPriority ?? (fileName === "MEMORY.md" ? 0 : 3), fileName);
  const type = meta.type || (fileName === "MEMORY.md" ? "index" : "memory-file");
  const name = meta.name || (fileName === "MEMORY.md" ? "MEMORY.md master index" : fileName.replace(/\.md$/, ""));
  const description = meta.description || "";
  return {
    content: body,
    category: "memory-file",
    metadata: {
      file_name: fileName,
      name,
      description,
      type,
      priority,
      load_priority: priority,
      source: "memory-file-sync-kit",
      synced_at: new Date().toISOString(),
    },
  };
}

function parsePriority(value, fileName) {
  const priority = Number(value);
  if (!Number.isFinite(priority)) {
    throw new Error(`invalid_priority: ${fileName} has non-numeric priority ${JSON.stringify(value)}`);
  }
  return priority;
}

export function frontmatterForRow(row) {
  const metadata = row.metadata || {};
  const lines = [
    "---",
    `name: ${metadata.name || metadata.file_name || row.id || "memory"}`,
    `description: ${metadata.description || ""}`,
    `type: ${metadata.type || "memory-file"}`,
    `priority: ${metadata.priority ?? metadata.load_priority ?? ""}`,
    "---",
    "",
    row.content || row.text || "",
    "",
  ];
  return lines.join("\n");
}

export async function readRecentMemoryFiles(config) {
  if (config.mockRecentFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(config.mockRecentFile, "utf8"));
      return Array.isArray(parsed) ? parsed : parsed.memories || parsed.results || [];
    } catch (error) {
      throw new Error(`mock_recent_file_error: ${error.message}`);
    }
  }
  const data = await memoryApi(config, "/recent?limit=500&category=memory-file");
  return data.memories || data.results || [];
}

export async function memoryApi(config, apiPath, options = {}) {
  let response;
  const url = `${config.apiUrl.replace(/\/+$/, "")}${apiPath}`;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        Authorization: `Bearer ${config.apiKey}`,
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw new Error(`fetch_failure: ${error.message}`);
  }
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`malformed_json: ${response.status} ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`request_failed: ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

export function groupRowsByFileName(rows) {
  const groups = new Map();
  for (const row of rows) {
    const fileName = row?.metadata?.file_name;
    if (!fileName) continue;
    const group = groups.get(fileName) || [];
    group.push(row);
    groups.set(fileName, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
  }
  return groups;
}

export function duplicateCandidates(rows) {
  return [...groupRowsByFileName(rows).entries()]
    .filter(([, group]) => group.length > 1)
    .map(([fileName, group]) => ({
      file_name: fileName,
      keep_id: group[0].id || null,
      duplicate_ids: group.slice(1).map((row) => row.id).filter(Boolean),
    }));
}

export async function writeMemoryFileRow(config, existing, payload) {
  if (!existing) {
    return memoryApi(config, "/add", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }
  return memoryApi(config, "/update", {
    method: "PUT",
    body: JSON.stringify({ id: existing.id, ...payload }),
  });
}

export async function deleteRow(config, rowId) {
  return memoryApi(config, `/${encodeURIComponent(rowId)}`, { method: "DELETE" });
}
