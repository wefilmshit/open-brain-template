# Recall Quality Upgrades

Five features that sit underneath the Memory Steward layer and raise the ceiling on what raw recall can return. Ship them in order or skip any phase independently. All inspired in part by Peter Simmons' engram-go work (github.com/petersimmons1972/engram-go) on local-first memory with relational recall.

The narrative:

- Raw semantic recall returns noise.
- Memory Steward filters that noise at the agent layer.
- These five features improve the signal coming INTO Memory Steward, so the agent has cleaner material to work with.

## Phase 1: Hybrid search (vector + BM25 + recency)

**Why:** Pure vector search misses exact-term matches and ignores freshness. Blending in BM25 and a recency boost closes both gaps with one RPC change.

**What changes:** `search_memories` RPC gets three signals instead of one. Same API surface, richer ranking.

**Formula:**

```
final_score =
  0.60 * vector_sim          -- semantic similarity (cosine)
+ 0.25 * bm25_score          -- exact-term match via ts_rank_cd
+ 0.15 * recency_boost       -- exp(-hours_since_created / 720), 30-day half-life
```

**SQL migration:**

```sql
CREATE OR REPLACE FUNCTION search_memories(
  query_embedding vector(3072),
  query_text text DEFAULT NULL,
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  filter_category text DEFAULT NULL,
  filter_tags text[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  content text,
  summary text,
  category text,
  source text,
  tags text[],
  metadata jsonb,
  created_at timestamptz,
  similarity float,
  bm25_score float,
  recency_score float,
  final_score float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.content, m.summary, m.category, m.source, m.tags, m.metadata, m.created_at,
    (1 - (m.embedding <=> query_embedding))::float AS similarity,
    COALESCE(ts_rank_cd(m.fts, websearch_to_tsquery('english', query_text)), 0.0)::float AS bm25_score,
    EXP(-EXTRACT(EPOCH FROM (now() - m.created_at)) / (720.0 * 3600.0))::float AS recency_score,
    (
      0.60 * (1 - (m.embedding <=> query_embedding))
      + 0.25 * COALESCE(ts_rank_cd(m.fts, websearch_to_tsquery('english', query_text)), 0.0)
      + 0.15 * EXP(-EXTRACT(EPOCH FROM (now() - m.created_at)) / (720.0 * 3600.0))
    )::float AS final_score
  FROM memories m
  WHERE
    (1 - (m.embedding <=> query_embedding)) > match_threshold
    AND (filter_category IS NULL OR m.category = filter_category)
    AND (filter_tags IS NULL OR m.tags && filter_tags)
  ORDER BY final_score DESC
  LIMIT match_count;
END;
$$;
```

`query_text` is optional. When null, `ts_rank_cd` returns 0 and the BM25 term drops out. The `memories` table needs an `fts` tsvector column maintained by a trigger; add one if you don't have it.

Pass the raw query text through from your `/search` endpoint to the RPC. Weights are a starting point, not gospel. Tune by running the decay audit before and after.

---

## Phase 2: Retrieval miss tracking

**Why:** You can only improve recall quality if you know when it failed. Most systems drop that signal on the floor.

**What changes:** A new `retrieval_miss_events` table + a `log_miss` MCP tool. When a recall returns nothing useful, the caller (human or agent) classifies why.

**Failure class vocabulary** (borrowed verbatim from engram-go so the data is comparable across systems):

- `vocabulary_mismatch` — semantic search missed the exact term
- `aggregation_failure` — query was compound, results only covered part
- `stale_ranking` — results outranked by newer more relevant ones
- `missing_content` — the memory genuinely does not exist yet
- `scope_mismatch` — wrong category or tag filter
- `other` — escape hatch

**Migration:**

```sql
CREATE TABLE IF NOT EXISTS retrieval_miss_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  query text NOT NULL,
  filter_category text,
  filter_tags text[],
  result_count int NOT NULL DEFAULT 0,
  failure_class text NOT NULL CHECK (failure_class IN (
    'vocabulary_mismatch',
    'aggregation_failure',
    'stale_ranking',
    'missing_content',
    'scope_mismatch',
    'other'
  )),
  notes text,
  logged_by text DEFAULT 'claude-code'
);

CREATE INDEX idx_miss_events_failure_class ON retrieval_miss_events(failure_class);
CREATE INDEX idx_miss_events_created_at ON retrieval_miss_events(created_at DESC);

ALTER TABLE retrieval_miss_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON retrieval_miss_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

The MCP tool pairs with a weekly decay audit (see `audit/`). Query-time misses plus temporal drift together give you two kinds of receipt on retrieval quality.

---

## Phase 3: Aggregate queries on memory_stats

**Why:** You want to query the SHAPE of the bank without reading individual records. Feeds dashboards and the audit baseline.

**What changes:** `memory_stats` tool accepts a `by` parameter. `by='default'` returns totals plus breakdowns by category, source, and month. `by='failure_class'` returns the miss distribution from Phase 2.

Low effort, high utility once Phase 2 is in place.

---

## Phase 4: Memory correction with audit preservation

**Why:** Raw update loses history. When you correct a memory, the next person asking "what did we used to think" has no path back.

**What changes:** A new `memory_correct` MCP tool backed by a `/correct` route. Fetches the existing row, stashes old `content` + `summary` into `metadata.superseded_from`, records the reason in `metadata.supersede_reason`, timestamps via `metadata.superseded_at`, and re-embeds so semantic search reflects the corrected content. Prior corrections append to `metadata.supersede_history` so the full chain is preserved.

```typescript
if (req.method === "POST" && path === "/correct") {
  const { id, content, summary, reason } = await req.json();
  if (!id) return error400("id is required");
  if (content === undefined && summary === undefined) {
    return error400("provide content or summary");
  }

  const { data: existing } = await supabase
    .from("memories")
    .select("id, content, summary, metadata")
    .eq("id", id)
    .single();
  if (!existing) return error404("not found");

  const meta = (existing.metadata || {}) as Record<string, unknown>;
  const priorHistory = Array.isArray(meta.supersede_history)
    ? meta.supersede_history as unknown[] : [];
  const priorSuperseded = meta.superseded_from;
  const newHistory = priorSuperseded
    ? [...priorHistory, priorSuperseded] : priorHistory;

  const newMetadata = {
    ...meta,
    superseded_from: { content: existing.content, summary: existing.summary },
    supersede_reason: reason || null,
    superseded_at: new Date().toISOString(),
    supersede_history: newHistory,
  };

  const newContent = content ?? existing.content;
  const newSummary = summary ?? existing.summary;
  const updates: Record<string, unknown> = { metadata: newMetadata };
  if (content !== undefined) updates.content = newContent;
  if (summary !== undefined) updates.summary = newSummary;
  updates.embedding = await getEmbedding(
    (newSummary || "") + "\n\n" + (newContent || "")
  );

  const { data } = await supabase
    .from("memories").update(updates).eq("id", id)
    .select("id, summary, category, metadata, created_at").single();

  return json({ success: true, memory: data });
}
```

`memory_correct` is strictly different from `forget`. Forget removes. Correct preserves.

---

## Phase 5: Knowledge graph edges

**Why:** Peter Simmons' line on the thread that started all this: _"adding the relationships to everything else is what cuts down on recalling the wrong memory."_ Individual memories are nodes. The knowledge is in the edges.

**What changes:** A new `memory_edges` table + a `memory_link` MCP tool. Directed, typed edges between memories.

**Relation vocabulary** (7, kept tight on purpose):

- `supersedes` — A replaces or corrects B. Pairs with Phase 4.
- `supports` — A provides evidence for B.
- `contradicts` — A disagrees with B.
- `derived_from` — A was inferred or synthesized from B.
- `related_to` — loose association, catch-all.
- `part_of` — A is a component of B (hierarchy).
- `follows` — A happened after B (temporal).

**Migration:**

```sql
CREATE TABLE IF NOT EXISTS memory_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  from_memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN (
    'supersedes', 'supports', 'contradicts',
    'derived_from', 'related_to', 'part_of', 'follows'
  )),
  notes text,
  created_by text DEFAULT 'claude-code',
  CONSTRAINT no_self_loops CHECK (from_memory_id <> to_memory_id),
  CONSTRAINT unique_edge UNIQUE (from_memory_id, to_memory_id, relation)
);

CREATE INDEX idx_memory_edges_from ON memory_edges(from_memory_id);
CREATE INDEX idx_memory_edges_to ON memory_edges(to_memory_id);
CREATE INDEX idx_memory_edges_relation ON memory_edges(relation);
CREATE INDEX idx_memory_edges_created_at ON memory_edges(created_at DESC);

ALTER TABLE memory_edges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON memory_edges
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

ON DELETE CASCADE means deleting a memory cleans up its edges automatically. The unique constraint prevents duplicate (from, to, relation) triples. Self-loops are rejected at the row level.

**API route:**

```typescript
if (req.method === "POST" && path === "/link") {
  const { from_memory_id, to_memory_id, relation, notes, created_by } = await req.json();

  if (!from_memory_id || !to_memory_id || !relation) return error400("from_memory_id, to_memory_id, relation required");
  if (from_memory_id === to_memory_id) return error400("self-loops not allowed");
  if (!VALID_RELATIONS.has(relation)) return error400("invalid relation");

  // Verify both memories exist so FK violation becomes a readable 404.
  const { data: found } = await supabase
    .from("memories").select("id").in("id", [from_memory_id, to_memory_id]);
  if (!found || found.length < 2) {
    const foundIds = new Set((found || []).map(r => r.id));
    const missing = [from_memory_id, to_memory_id].filter(id => !foundIds.has(id));
    return error404(`memory not found: ${missing.join(', ')}`);
  }

  const { data, error } = await supabase
    .from("memory_edges")
    .insert({ from_memory_id, to_memory_id, relation, notes, created_by })
    .select("id, from_memory_id, to_memory_id, relation, created_at")
    .single();

  if (error?.code === '23505') {
    return error409(`edge already exists: (${from_memory_id}) -[${relation}]-> (${to_memory_id})`);
  }
  if (error) throw error;

  return json({ success: true, edge: data });
}
```

**Traversal:** Read path is intentionally not included as an MCP tool in v1. Use raw SQL against `memory_edges` joined with `memories` for now. Add `/edges/:memory_id` or a `memory_neighbors` tool if the pattern stabilizes.

---

## Ordering + rollback

Each phase is independently shippable and independently reversible. Rough rollout order:

1. Phase 1 gives the biggest immediate lift, rolls out everywhere at once, no client changes.
2. Phase 2 + 3 ship together, they share the miss-events table.
3. Phase 4 is small, can land any time after Phase 1.
4. Phase 5 is the biggest scope but self-contained. Ship when you want graph recall.

Rollback for any phase is the reverse migration plus reverting the MCP tool definition on your server.

---

## Credit

The retrieval miss vocabulary, the "local first with relational recall" framing, and the graph-edges nudge all came from Peter Simmons' engram-go (github.com/petersimmons1972/engram-go). Myles Bryning's framing on the same thread was the final push: _"Dream all you want, just keep a receipt of what you dreamt."_ These five features are the receipt.
