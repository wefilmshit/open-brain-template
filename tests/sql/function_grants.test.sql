-- Core function grants (migration 0004). Run with:
--   scripts/run-local-sql-test.sh supabase/migrations/0002_memory_delete_guard.sql \
--     supabase/migrations/0003_literal_text_search.sql \
--     supabase/migrations/0004_revoke_public_function_execute.sql tests/sql/function_grants.test.sql
-- The runner applies Supabase's default privileges first, so anon and authenticated start with
-- EXECUTE on every new function; this test fails unless 0004 takes it away.
DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.archive_memory(uuid, text, text)',
    'public.restore_memory(uuid)',
    'public.match_memories_basic(vector, int, text)',
    'public.search_memories_text(text, integer, text)'
  ] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(r, fn, 'EXECUTE') THEN
        RAISE EXCEPTION '% can execute %', r, fn;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute %', fn;
    END IF;
  END LOOP;
END
$$;

SELECT 'function grant tests: PASS' AS result;
