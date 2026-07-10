-- Open Brain memory core schema.
--
-- Implements the base contract already documented in this repo's CLAUDE.md
-- Step 1 (memories table, vector(768) embedding), plus the fixes described in
-- docs/self-hosting-fixes.md: content-fingerprint dedup-on-write and a
-- restorable archive shelf.
--
-- NOTE on embedding dimension: docs/recall-quality.md's Phase 1 example SQL
-- uses vector(3072). That is a pre-existing inconsistency between two already
-- published docs in this repo (CLAUDE.md's setup instructions say 768; the
-- optional Phase 1 upgrade's example uses 3072). This migration follows
-- CLAUDE.md's Step 1, the primary onboarding contract. If you adopt the
-- optional Phase 1 hybrid-search upgrade from docs/recall-quality.md and your
-- embedding model produces a different dimension, alter the embedding column
-- to match before adding vectors.

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ── memories ────────────────────────────────────────────────────────────
create table if not exists public.memories (
  id                  uuid primary key default gen_random_uuid(),
  content             text not null,
  summary             text,
  category            text default 'general',
  source              text default 'manual',
  tags                text[] default '{}',
  metadata            jsonb default '{}'::jsonb,
  embedding           vector(768),
  confirmation_status text not null default 'evidence',
  content_fingerprint text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

comment on column public.memories.confirmation_status is
  'Free-text trust label (evidence/confirmed/imported/disputed by convention). '
  'This template does NOT enforce a tiered write-trust cap -- any caller with a '
  'valid API key may set any value. Add your own enforcement in memory-api if '
  'you need one; see docs/self-hosting-fixes.md for the design tradeoff.';

comment on column public.memories.content_fingerprint is
  'sha256(content), lowercase hex. On write (POST /add), if a row with the same '
  'fingerprint already exists, memory-api updates that row instead of inserting '
  'a duplicate. See docs/self-hosting-fixes.md.';

create index if not exists idx_memories_category on public.memories(category);
create index if not exists idx_memories_created_at on public.memories(created_at desc);
create index if not exists idx_memories_content_fingerprint on public.memories(content_fingerprint);
create index if not exists idx_memories_tags on public.memories using gin(tags);
create index if not exists idx_memories_metadata on public.memories using gin(metadata);
create index if not exists idx_memories_embedding on public.memories
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

alter table public.memories enable row level security;
create policy "service_role_full_access" on public.memories
  for all to service_role using (true) with check (true);

-- ── memories_archive (restorable archive shelf) ────────────────────────
-- Same shape as memories, plus archive bookkeeping. A row's id is preserved
-- across an archive/restore round trip.
create table if not exists public.memories_archive (
  id                  uuid primary key,
  content             text not null,
  summary             text,
  category            text,
  source              text,
  tags                text[],
  metadata            jsonb,
  embedding           vector(768),
  confirmation_status text,
  content_fingerprint text,
  created_at          timestamptz,
  updated_at          timestamptz,
  archived_at         timestamptz not null default now(),
  archived_by         text,
  archive_reason      text
);

create index if not exists idx_memories_archive_archived_at
  on public.memories_archive(archived_at desc);

alter table public.memories_archive enable row level security;
create policy "service_role_full_access" on public.memories_archive
  for all to service_role using (true) with check (true);

-- ── archive_memory / restore_memory (atomic moves) ─────────────────────
-- Single-transaction moves. A partial failure (e.g. a crash between an
-- INSERT and a DELETE done as two separate application-level calls) can
-- either duplicate a row or, worse, delete it without ever landing in the
-- archive. Doing the move inside one plpgsql function makes it atomic: both
-- halves happen or neither does.
create or replace function public.archive_memory(
  p_id uuid,
  p_archived_by text default null,
  p_archive_reason text default null
)
returns public.memories_archive
language plpgsql
as $$
declare
  v_row public.memories_archive;
begin
  insert into public.memories_archive (
    id, content, summary, category, source, tags, metadata, embedding,
    confirmation_status, content_fingerprint, created_at, updated_at,
    archived_by, archive_reason
  )
  select
    id, content, summary, category, source, tags, metadata, embedding,
    confirmation_status, content_fingerprint, created_at, updated_at,
    p_archived_by, p_archive_reason
  from public.memories
  where id = p_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'memory % not found', p_id using errcode = 'P0002';
  end if;

  delete from public.memories where id = p_id;

  return v_row;
end;
$$;

create or replace function public.restore_memory(p_id uuid)
returns public.memories
language plpgsql
as $$
declare
  v_row public.memories;
begin
  insert into public.memories (
    id, content, summary, category, source, tags, metadata, embedding,
    confirmation_status, content_fingerprint, created_at, updated_at
  )
  select
    id, content, summary, category, source, tags, metadata, embedding,
    confirmation_status, content_fingerprint, created_at, updated_at
  from public.memories_archive
  where id = p_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'archived memory % not found', p_id using errcode = 'P0002';
  end if;

  delete from public.memories_archive where id = p_id;

  return v_row;
end;
$$;

grant execute on function public.archive_memory(uuid, text, text) to service_role;
grant execute on function public.restore_memory(uuid) to service_role;

-- ── match_memories_basic (optional bring-your-own-embedding search) ────
-- This repo's default /search and /recall routes do keyword matching (see
-- README.md: dashboard search is intentionally keyword search unless you
-- wire and prove semantic search separately). If a caller supplies a
-- precomputed embedding vector to POST /recall, memory-api calls this RPC
-- for cosine-similarity search instead. No embedding provider is hardcoded
-- here -- computing the vector is the caller's job.
create or replace function public.match_memories_basic(
  query_embedding vector(768),
  match_count int default 10,
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
  updated_at timestamptz,
  similarity float
)
language sql
stable
as $$
  select
    m.id, m.content, m.summary, m.category, m.source, m.tags, m.metadata,
    m.confirmation_status, m.created_at, m.updated_at,
    (1 - (m.embedding <=> query_embedding))::float as similarity
  from public.memories m
  where m.embedding is not null
    and (filter_category is null or m.category = filter_category)
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function public.match_memories_basic(vector, int, text) to service_role;
