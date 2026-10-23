# Upgrading an existing Open Brain install

This release adds a delete guard, delete audit, literal text search, stricter API authentication and a memory-content safety check. Existing installs need the steps below.

## Apply the delete guard migration

Apply `supabase/migrations/0002_memory_delete_guard.sql` after your existing `0001_open_brain_memory_core.sql` migration. In a hosted Supabase project, open the SQL editor, paste the complete `0002_memory_delete_guard.sql` file and run it once.

For a disposable local Postgres 17 database with pgvector installed, this repository verifies both migrations and the guard with:

```bash
scripts/run-local-sql-test.sh supabase/migrations/0002_memory_delete_guard.sql tests/sql/memory_delete_guard.test.sql
```

The migration records every deleted memory in `public.memory_delete_audit`. It blocks a statement that deletes more than 25 memories unless that transaction explicitly enables the override.

## Redeploy the memory API

Redeploy `supabase/functions/memory-api/` after applying the migration. Keep `MEMORY_API_KEY` set to the same private value used by your memory-server client. The client now sends that value as a Bearer token.

## New settings

- `MEMORY_API_ALLOWED_ORIGINS` is a comma-separated list of browser origins allowed by the memory API. The default is empty, which sends no cross-origin permission. Set it to `*` only as a deliberate off switch.
- `MEMORY_WRITE_SAFETY` controls memory-content checks. The default is `enforce`. Use `observe` to allow the write while recording reason codes in `metadata.write_safety`, or `off` to disable the check.

## If a write returns 422 UNSAFE_CONTENT

The memory looked like it contained a secret, a raw transcript, or more than 32,768 characters. The response lists reason codes, never the detected text. Remove the secret, summarize the transcript, or split oversized content, then submit the cleaned memory again. Do not bypass the filter just to store credentials.

## Deliberate bulk deletes

The default limit is 25 rows per delete statement. For an intentional reviewed cleanup, keep the override and delete in the same transaction:

```sql
BEGIN;
SET LOCAL app.allow_mass_delete = 'on';
DELETE FROM public.memories WHERE category = 'reviewed-cleanup-target';
COMMIT;
```

`SET LOCAL` expires with the transaction. The row-level audit trigger still records every deleted memory.

## Credit

The grants-audit and mass-delete guard ideas were informed by [OB1 by NateBJones-Projects](https://github.com/NateBJones-Projects/OB1). The implementation and tests here are adapted to Open Brain's schema and deployment model.
