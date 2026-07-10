# Supabase Backend

The database schema and the `memory-api` Edge Function that the dashboard,
`api/memories.js`, `scripts/memory-sync/`, and `memory-server/` all talk to.

## 1. Prerequisites

- A Supabase project ([supabase.com](https://supabase.com)).
- The [Supabase CLI](https://supabase.com/docs/guides/cli) installed and
  logged in (`supabase login`).
- `vector` and `pgcrypto` Postgres extensions -- the migration enables both
  itself; nothing to do manually.

## 2. Apply the migration

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

This creates `memories`, `memories_archive`, and the `archive_memory` /
`restore_memory` / `match_memories_basic` functions. See
`migrations/0001_open_brain_memory_core.sql` for the full schema and the
comments explaining each design decision.

## 3. Set the Edge Function secrets

```bash
supabase secrets set MEMORY_API_KEY="$(openssl rand -hex 32)"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already available to every
Edge Function in your project automatically -- you do not set those
yourself.

Save the `MEMORY_API_KEY` value; it goes into `MEMORY_API_URL`/`MEMORY_API_KEY`
in the dashboard's Vercel environment, `memory-server/.env`, and
`scripts/memory-sync/`'s environment. Treat it like a password -- anyone who
has it can read and write your entire memory store.

## 4. Deploy the function

```bash
supabase functions deploy memory-api --no-verify-jwt
```

**`--no-verify-jwt` is required.** This function is guarded by the
`MEMORY_API_KEY` header check inside the function itself (`x-api-key` or
`Authorization: Bearer`), not by Supabase's platform-level JWT check. If you
deploy without `--no-verify-jwt`, Supabase's platform will reject every
request with `401 UNAUTHORIZED_INVALID_JWT_FORMAT` before your function code
ever runs -- including from the dashboard, the sync scripts, and
`memory-server`. If that happens, redeploy with the flag; it is a config
setting on the function, not a data problem, and does not need a rollback.

## 5. Verify

```bash
curl -s -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/memory-api/add" \
  -H "x-api-key: $MEMORY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "hello world", "summary": "smoke test"}'
```

Expect `{"success":true,"memory":{...}}`. Then confirm `/stats` reports a
total of at least 1:

```bash
curl -s "https://YOUR_PROJECT_REF.supabase.co/functions/v1/memory-api/stats" \
  -H "x-api-key: $MEMORY_API_KEY"
```

## Route reference

| Route | Method | Purpose |
|---|---|---|
| `/add` | POST | Create a memory (dedups by content fingerprint). |
| `/update` | PUT | Update a memory by `id`. |
| `/correct` | POST | Update in place, preserving prior content in `metadata.supersede_history`. |
| `/recent` | GET | List recent memories (`limit`, `category`). |
| `/search` | GET | Keyword search (`q`, `limit`). |
| `/recall` | POST | Capped search for agent callers (top-K + byte budget; optional `embedding`). |
| `/stats` | GET | Exact total + category/source breakdown. |
| `/delete` | DELETE | Delete by `id` in the request body. |
| `/:id` | DELETE | Delete by `id` in the URL path. |
| `/:id/archive` | POST | Move to the restorable archive shelf. |
| `/:id/restore` | POST | Move back from the archive shelf. |

Both delete shapes exist because `index.html` and `scripts/memory-sync/lib.mjs`
already used different ones before this change; both are supported rather
than picking one and breaking the other client.

See `docs/self-hosting-fixes.md` for the reasoning behind the cap, the dedup
signal, the archive design, and everything else in this function.
