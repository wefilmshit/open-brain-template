# Memory File Sync Kit

This optional advanced kit syncs local markdown memory files with Open Brain `memory-file` rows.

You do not need this kit to run Open Brain. Use it when you want a folder of markdown files to stay aligned with the rows your agents can load through the memory API.

No scheduler is enabled by default. Any cron, launchd, or CI example you build around these scripts should stay explicit and reviewable.

## Files

- `scripts/memory-sync/push-memory-files.mjs` pushes local `.md` files into Open Brain.
- `scripts/memory-sync/pull-memory-files.mjs` pulls Open Brain `memory-file` rows into local `.md` files.
- `scripts/memory-sync/sync-memory-floor.mjs` compares local files and remote rows without writing.
- `scripts/memory-sync/priority-map.example.json` shows how to pin file priorities.

## Configuration

Use environment variables or CLI arguments:

```bash
export MEMORY_API_URL="https://your-project.supabase.co/functions/v1/memory-api"
export MEMORY_API_KEY="your-memory-api-key"
export MEMORY_FILES_DIR="./memory"
```

Equivalent CLI flags:

```bash
node scripts/memory-sync/push-memory-files.mjs \
  --api-url "$MEMORY_API_URL" \
  --api-key "$MEMORY_API_KEY" \
  --memory-dir ./memory \
  --priority-map scripts/memory-sync/priority-map.example.json \
  --dry-run
```

The scripts use `metadata.file_name` as the stable identity key. That means `rules.md` updates the existing `rules.md` row instead of creating a fresh row every run.

## Markdown Frontmatter

Frontmatter is optional. Supported fields:

```md
---
name: Project Rules
description: Rules the agent should load before project work.
type: rules
priority: 1
---

The body becomes the memory content.
```

If `MEMORY.md` exists, it is treated as the index and gets priority `0` unless frontmatter or a priority map overrides it.

## Push

Dry-run first:

```bash
node scripts/memory-sync/push-memory-files.mjs --memory-dir ./memory --dry-run
```

Apply writes:

```bash
node scripts/memory-sync/push-memory-files.mjs --memory-dir ./memory
```

Duplicate cleanup is never automatic. The push script reports duplicate candidates in dry-run. To delete duplicates after keeping the newest row for each `metadata.file_name`, add an explicit flag:

```bash
node scripts/memory-sync/push-memory-files.mjs --memory-dir ./memory --delete-duplicates
```

## Pull

Dry-run first:

```bash
node scripts/memory-sync/pull-memory-files.mjs --memory-dir ./memory --dry-run
```

Apply writes:

```bash
node scripts/memory-sync/pull-memory-files.mjs --memory-dir ./memory
```

Pull keeps the newest row for each `metadata.file_name` and reports skipped duplicate row IDs. It does not delete remote rows.

## Floor Audit

Use the floor audit when you want to know whether local files and remote rows still match:

```bash
node scripts/memory-sync/sync-memory-floor.mjs --memory-dir ./memory
```

It reports `local_only`, `remote_only`, `present_in_both`, priority counts, and duplicate candidates. It does not write.

## JSON Reports

All scripts print JSON reports. Errors are structured so another agent, CI job, or human can tell the difference between:

- bad URL
- missing API key
- fetch failure
- malformed API JSON
- failed write

That is intentionally boring. Boring sync tools are the ones that do not turn a memory bank into confetti.
