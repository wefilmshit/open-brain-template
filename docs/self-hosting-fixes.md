# Self-Hosting Fixes

A running Open Brain memory store degrades in specific, avoidable ways once
you actually use it: recall payloads grow unbounded, the same content gets
saved twice, a hard delete loses data you meant to keep, and a write gets
rejected for missing a field nobody agreed was mandatory. This doc explains
the fixes shipped in `memory-server/` and `supabase/functions/memory-api/`,
and why each one is built the way it is.

## Recall size cap (top-K + byte budget)

`POST /recall` and `GET /search` both cap what they return: a maximum row
count (`RECALL_MAX_RESULTS_HARD` = 10 rows) and a total byte budget
(`RECALL_BYTE_BUDGET` = 8192 bytes) applied together. Content beyond
`RECALL_CONTENT_MAX_CHARS` (400) is truncated with a `content_truncated: true`
flag rather than silently dropped.

Why both a row cap and a byte budget: a handful of very large memories can
still blow a byte budget even under a small row cap. Capping only by count
does not bound payload size; capping only by bytes can silently return zero
useful rows if the first one is huge. Doing both, in that order, is what
actually bounds the response.

## Content-fingerprint dedup on write

`content_fingerprint = sha256(content)`, stored on every row. On `POST
/add`, if a row with the same fingerprint already exists, memory-api updates
that row (merging tags and metadata) instead of inserting a duplicate.

This is deliberately **byte-identity only** -- never filename, never
similarity, never "same target, keep the newest." Those heuristics look
correct and are not: a filename-based dedup will flag rows that merely
*mention* a file as duplicates of it; a similarity threshold can merge two
memories that differ by one meaningful word. Byte-identity is the only
signal that cannot destroy information by mistake. If you want a broader
duplicate sweep, do it with a human reading a sample from each proposed
group -- not an automatic merge.

## Restorable archive shelf

`memory_archive` moves a row to `memories_archive` instead of deleting it.
`memory_restore` moves it back, id preserved. The move is atomic (a single
`plpgsql` function, not three separate application-level calls) so a crash
mid-move cannot duplicate the row or lose it -- either the whole move
happens or none of it does.

If a Mem0 mirror is enabled, archiving also **purges the mirror copy**.
Archiving a row out of the primary store while its Mem0 mirror keeps serving
the old content in recall makes the archive cosmetic -- the row still shows
up, just from a different table. The purge is what makes the archive
actually clear recall.

### Quiet-mode responses

`memory_archive` and `memory_restore` return only the confirmation fields
(id, timestamps, `mem0_deleted` count) -- never the row's embedding vector.
Echoing a ~700-3000 number vector on every archived row multiplies the
response size for no reason; a batch archive pass over hundreds of rows
turns that into a real cost for zero benefit.

## remember() tolerance: derive, never reject, never silent

`remember` used to require both `content` and `summary`. Two overlapping
fields, one hard requirement -- and if a caller (human or agent) provides
only one, the naive fix is to reject the write. A lost memory is worth
zero; a weak summary is worth most of the memory. So `remember` now accepts
either field alone and derives the other.

**The derivation is flagged, never silent.** A derived summary sets
`metadata.summary_derived = true`; a derived content sets
`metadata.content_derived = true`. This matters because `recall`'s byte
budget truncates `content` but returns `summary` in full -- in a capped
recall, the summary is often the only thing a caller actually reads. A
truncation dressed up as a hand-written summary is a destroyed signal that
looks intact. Flagging it means a later hygiene pass can find and
regenerate every derived summary; silently accepting it means you never
know which summaries are actually just truncated content.

Only when **both** fields are missing does `remember` reject the write --
there is nothing to derive from.

## Mem0 correct-sync (`infer:false`)

`memory_correct` updates a memory in place and preserves the prior
content/summary in `metadata.supersede_history` -- it never creates a
second row for a correction. If a Mem0 mirror is enabled, the mirror's
copy of that memory is re-mirrored with the corrected text.

**The trade-off:** every Mem0 write in this template passes `infer:false`.
Mem0's default behavior runs your text through an LLM extraction pass and
rewrites it into Mem0's own phrasing, with auto-derived categories/tags.
`infer:false` stores your text verbatim instead -- exact storage, at the
cost of losing Mem0's automatic tagging. Without `infer:false`, a
correction against a paraphrased mirror can drift further from the
canonical row on every correction, which defeats the point of correcting
it. If you want Mem0's inference behavior, remove `infer:false` in
`memory-server/lib/mem0.mjs` -- but expect the mirror to diverge from what
`memory-api` holds.

## Exact `/stats` count

`GET /stats` takes an exact `count: "exact", head: true` query for the
total, then pages the category/source breakdown so neither number is
silently capped by a default row-fetch limit. A stats endpoint that reports
a row-fetch cap as if it were the store size is a common, easy-to-miss bug:
it looks like a real number, and it is wrong the moment your store grows
past the cap.

## Dashboard "+ New File" upsert-by-filename

The dashboard's Editor tab already had a create-file form
(`showCreateFileForm` / `createFile` in `index.html`). It always called
`POST /add`, with no lookup -- re-saving a file with the same name created a
second row instead of updating the first. `createFile` now looks the file
up by `metadata.file_name` in the already-loaded file list and calls `PUT
/update` on a match (with a confirmation prompt), falling back to `POST
/add` only for a genuinely new name.

This is deliberately **not** the same code path as
`scripts/memory-sync/push-memory-files.mjs`, which already does this
correctly for the CLI sync kit (see `docs/memory-file-sync.md`). The
dashboard form is a separate client, so it needed its own fix.

## A known, pre-existing doc inconsistency (not resolved here)

`CLAUDE.md`'s Step 1 setup instructions specify `embedding vector(768)`.
`docs/recall-quality.md`'s Phase 1 example SQL uses `vector(3072)`. Both
were already published before this change. `supabase/migrations/` follows
`CLAUDE.md`'s `vector(768)`, the primary onboarding contract. If you adopt
the optional Phase 1 hybrid-search upgrade and your embedding model produces
a different dimension, you will need to alter the `embedding` column
yourself before the two are compatible.

## What this does NOT add

`docs/recall-quality.md` documents five phases; this change ships the base
schema plus Phase 4 (`/correct`, needed for Mem0 correct-sync). Phases 1
(hybrid-search weighting), 2 (retrieval-miss tracking), 3 (`/stats`
`by=failure_class`), and 5 (knowledge-graph edges via `memory_link`) are
not included -- the doc already describes each as independently shippable
and independently reversible. Add them separately if you want them; they do
not depend on anything in this change.

There is also no tiered write-trust system -- no mechanism that lets only
some credentials mint a high-confidence `confirmation_status`. Any caller
with a valid `MEMORY_API_KEY` may set any `confirmation_status` value. If
your use case needs one, it is a deliberate design decision with real
trade-offs -- add it yourself in `memory-api/index.ts` rather than assume
this template has it.
