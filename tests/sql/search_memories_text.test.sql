-- Literal text search (migration 0003). Run with:
--   scripts/run-local-sql-test.sh supabase/migrations/0002_memory_delete_guard.sql \
--     supabase/migrations/0003_literal_text_search.sql tests/sql/search_memories_text.test.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END
$$;

INSERT INTO public.memories (content, summary, category, created_at)
SELECT c, 'none', 'fixture', now() - interval '1 day'
FROM unnest(ARRAY['50% off', 'a,b', 'plain', 'say "hi"', 'back\slash', '(paren)', 'under_score',
                  'star*x', 'dot.name', 'café', 'abc', 'id is here', 'why?']) AS c;
INSERT INTO public.memories (content, summary, category) VALUES ('zzz', 'needle in the summary', 'fixture');
INSERT INTO public.memories (content, summary, category, created_at)
SELECT 'bulk ' || n, 'none', 'bulk', now() - (n || ' minutes')::interval FROM generate_series(1, 120) AS n;

CREATE TEMP TABLE cases (q text, want text[]);
INSERT INTO cases VALUES
  ('*', ARRAY['star*x']), ('r*x', ARRAY['star*x']), ('%*%', ARRAY[]::text[]), ('?', ARRAY['why?']),
  ('%', ARRAY['50% off']), ('_', ARRAY['under_score']), (E'\\', ARRAY[E'back\\slash']),
  (',', ARRAY['a,b']), ('"', ARRAY['say "hi"']), ('(', ARRAY['(paren)']), (')', ARRAY['(paren)']),
  ('.', ARRAY['dot.name']), ('a,b', ARRAY['a,b']), ('50% off', ARRAY['50% off']), ('hi"', ARRAY['say "hi"']),
  ('a,id.not.is.null', ARRAY[]::text[]), ('x)', ARRAY[]::text[]), ('%25', ARRAY[]::text[]),
  ('café', ARRAY['café']), ('CAFÉ', ARRAY['café']), ('PLAIN', ARRAY['plain']), ('needle', ARRAY['zzz']),
  (repeat('x', 2048), ARRAY[]::text[]);

DO $$
DECLARE
  c record;
  got text[];
BEGIN
  FOR c IN SELECT * FROM cases LOOP
    SELECT coalesce(array_agg(content ORDER BY content), ARRAY[]::text[]) INTO got
    FROM public.search_memories_text(c.q, 100, 'fixture');
    IF got IS DISTINCT FROM (SELECT coalesce(array_agg(w ORDER BY w), ARRAY[]::text[]) FROM unnest(c.want) w) THEN
      RAISE EXCEPTION 'search % returned %, expected %', left(c.q, 40), got, c.want;
    END IF;
  END LOOP;
END
$$;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.search_memories_text('', 100)) <> 0 THEN RAISE EXCEPTION 'empty q returned rows'; END IF;
  IF (SELECT count(*) FROM public.search_memories_text('   ', 100)) <> 0 THEN RAISE EXCEPTION 'blank q returned rows'; END IF;
  IF (SELECT count(*) FROM public.search_memories_text(NULL, 100)) <> 0 THEN RAISE EXCEPTION 'null q returned rows'; END IF;
  IF (SELECT count(*) FROM public.search_memories_text('bulk', 1000)) <> 100 THEN RAISE EXCEPTION 'lim was not capped at 100'; END IF;
  IF (SELECT count(*) FROM public.search_memories_text('bulk', 0)) <> 1 THEN RAISE EXCEPTION 'lim 0 was not raised to 1'; END IF;
  IF (SELECT count(*) FROM public.search_memories_text('bulk', NULL)) <> 50 THEN RAISE EXCEPTION 'null lim did not default to 50'; END IF;
  IF (SELECT count(*) FROM public.search_memories_text('bulk', 100, 'fixture')) <> 0 THEN RAISE EXCEPTION 'category filter ignored'; END IF;
  IF (SELECT content FROM public.search_memories_text('bulk', 1) LIMIT 1) <> 'bulk 1' THEN RAISE EXCEPTION 'not newest first'; END IF;
END
$$;

-- Only service_role may call it.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', r);
      PERFORM public.search_memories_text('plain', 10);
      RAISE EXCEPTION '% was allowed to call search_memories_text', r;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    RESET ROLE;
  END LOOP;
  SET LOCAL ROLE service_role;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proname = 'search_memories_text' AND p.prosecdef = false) THEN
    RAISE EXCEPTION 'function must be SECURITY INVOKER';
  END IF;
  RESET ROLE;
  IF NOT has_function_privilege('service_role', 'public.search_memories_text(text, integer, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute';
  END IF;
  IF has_function_privilege('anon', 'public.search_memories_text(text, integer, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.search_memories_text(text, integer, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon or authenticated can execute';
  END IF;
END
$$;

SELECT 'search_memories_text tests: PASS' AS result;
