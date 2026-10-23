-- 0003: literal text search with no pattern syntax.
--
-- memory-api used to search with PostgREST's `ilike` filter. PostgREST rewrites `*` to `%`
-- inside a like/ilike pattern before Postgres sees it, even when quoted or backslash-escaped,
-- so a search for `*` (or `r*x`) matched far more rows than it should. Measured against a real
-- PostgREST v16.4 on 2026-10-23; see UPGRADING.md.
--
-- This function matches with strpos() on lower-cased text: a plain substring test with no
-- wildcard characters at all, so nothing in the query can widen it. memory-api's /search and
-- /recall (keyword path) call it through `.rpc("search_memories_text", ...)`.

create or replace function public.search_memories_text(
  q text,
  lim integer default 50,
  filter_category text default null
)
returns table (
  id uuid,
  content text,
  summary text,
  category text,
  source text,
  tags text[],
  metadata jsonb,
  confirmation_status text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.id, m.content, m.summary, m.category, m.source, m.tags, m.metadata,
         m.confirmation_status, m.created_at, m.updated_at
  from public.memories as m
  where pg_catalog.btrim(coalesce(q, '')) <> ''
    and (
      pg_catalog.strpos(pg_catalog.lower(m.content), pg_catalog.lower(q)) > 0
      or pg_catalog.strpos(pg_catalog.lower(coalesce(m.summary, '')), pg_catalog.lower(q)) > 0
    )
    and (filter_category is null or m.category = filter_category)
  order by m.created_at desc
  limit greatest(1, least(coalesce(lim, 50), 100));  -- greatest/least are SQL syntax, not search_path functions
$$;

-- Only memory-api's role may call it. Supabase grants EXECUTE on new public functions to anon
-- and authenticated by default, and Postgres grants it to PUBLIC, so revoke all three.
revoke all on function public.search_memories_text(text, integer, text) from public, anon, authenticated;
grant execute on function public.search_memories_text(text, integer, text) to service_role;
