# Open Brain Optimization Kit

This kit gives an Open Brain owner a repeatable way to improve memory quality without guessing, shipping blind, or mixing private runtime state into a public template.

Use it when you are tuning recall, adding dashboard search, changing memory ranking, publishing a template, adding Prime Radiant operating-board behavior, or writing a handoff for another agent or developer.

## What This Kit Includes

- Smoke checks for dashboard search, memory health, and private-leak scanning.
- Eval checks for recall baselines and before/after quality comparisons.
- Templates for closeouts, gate reports, and rollout reports.
- Prime Radiant templates for lanes, board readiness, and write-back reports.
- Prompt packs for builder, reviewer, steward, and hygiene roles.
- Prime Radiant reviewer prompt for board, gate, and write-back review.
- Plain-English playbooks for common memory-system failure modes.

## Public Boundary

The kit is reusable operating material, not a copy of anyone's private system.

Do not add:

- Private memories, personal records, client records, or local artifact paths.
- API keys, bearer tokens, service-role keys, private Mem0 namespace names, or deployment credentials.
- Private agent personas or private team-specific routing rules.
- Claims that a keyword dashboard search is semantic recall.
- Claims that dry-run Prime Radiant proof is live-write approval.

If a guide needs private lore to make sense, rewrite it until a stranger can use it with their own Open Brain.

## Baseline Before Optimizing

Before changing recall, ranking, search, or dashboard behavior:

1. Choose a frozen query set.
2. Record current quality:
   - expected memory IDs or answer summaries
   - recall at top 10 and top 50 when applicable
   - missing targets
   - wrong-primary answers
3. Record current speed:
   - p50
   - p95
   - max
   - timeout count
4. Record the runtime surface:
   - local, preview, shadow, or production
   - branch or deploy ID
   - environment variables used, without printing secrets
5. Save the baseline result before building.

Optimization without a baseline is just moving the furniture during a fire.

## Separate Speed From Quality

Speed and quality are different gates.

Pass examples:

- Quality holds and latency improves.
- Quality improves and latency stays inside the accepted budget.

Hold examples:

- Latency improves but target memories disappear.
- Search stops timing out by becoming keyword-only while the UI still promises semantic recall.
- A shadow build looks fast but uses a different denominator than production.

If you intentionally change the denominator, say so in the UI and closeout.

## Shadow Builds Stay Out Of Production

Use a shadow or preview build when the change touches retrieval, ranking, vector indexes, or memory semantics.

Shadow closeout must include:

- branch or deploy URL
- exact diff or migration name
- rollback path
- frozen eval instructions
- proof that production was not changed

Do not promote a shadow result because it feels good. Promote only after the frozen gate passes and the operator stamps the live change.

## Dashboard Search Versus Agent Recall

Dashboard search is a user interface feature.

Agent recall is the memory system the assistant uses to reason.

They may share data, but they are not automatically the same product. If the dashboard uses keyword search over recent memories, label it as keyword search. If it uses semantic/Mem0 recall, prove that route separately and keep latency bounded.

Good wording:

- `Keyword search recent memories`
- `Searches recent-memory keywords; semantic recall remains in agent memory.`

Bad wording:

- `Search all memories` when the route scans only recent rows.
- `Semantic search` when the route is keyword matching.

## Stale Board Rows

A stale board row usually means missing evidence, stale cursor metadata, or an unmapped worktree. It does not automatically mean the product is broken.

In this guide, a plan cursor is the plan's current status block, a closeout artifact is a saved proof note, and a board collector is the script or job that turns those proofs into dashboard rows.

Diagnose in order:

1. Read the plan cursor.
2. Check for newer commits after the cursor timestamp.
3. Check for newer closeout artifacts bound to the same plan and slice.
4. Rerun the board collector or drift check.
5. Only then decide whether the row is real drift, missing evidence, or a false classifier.

## Prime Radiant Gates

Prime Radiant gates must stay separate.

Do not blend:

- read-only board proof
- interactive picture proof
- receiver dry-run proof
- deployed dry-run proof
- live assignment write proof
- replay proof
- rollback proof
- public claim proof

Each gate gets its own receipt. A green board row does not authorize a live write. A live write does not prove rollback. A rollback does not authorize the next operation.

## Agent Roster And Project Tags

Prime Radiant needs an agent roster before assignment state is meaningful.

Record:

- agent id
- display name
- availability
- project tags
- lane tags
- allowed operations
- current assignments

Do not infer authority from a display name. Authority belongs in allowed operations.

## Memory Red-Team / Seldon Crisis Guard

Use observe-only mode before any park or block behavior.

Track:

- stale memory
- duplicate memory
- contradictory memory
- bad recall
- missing proof
- stale Chevrons
- board rows that cannot be checked
- claims that promote dry-run or preview proof into live proof

Park/block behavior needs measured false-positive rates and operator approval. A guard that blocks good memories is not a guard. It is an outage with manners.

## Duplicate Memories

When duplicate memories pile up:

1. Identify whether they are exact duplicates, near duplicates, or true contradictions.
2. Keep the survivor with the clearest summary and best provenance.
3. Mark or link the duplicate instead of deleting unless deletion is explicitly approved.
4. Verify recall no longer surfaces the dud ahead of the survivor.

Do not solve duplicate memories by hiding every inconvenient result. That is not deduplication. That is a broom with a login.

## Bad Search

When search returns the wrong answer:

1. Ask whether the target is missing from the raw candidate set or merely ranked too low.
2. If missing, fix candidate generation.
3. If present but low, fix ranking.
4. If present but the answer chooses the wrong item, fix answer carry-through.
5. Re-run the same eval set before declaring victory.

Never use a per-query answer table as a recall fix. That passes the benchmark and fails the product.

## Slow Recall

When recall is slow:

1. Split timing into embedding, database search, fallback search, merge, and answer generation.
2. Reproduce on target rows plus one healthy control.
3. Compare cold and warm timings separately.
4. Bound fallback calls.
5. Avoid serial second-pass searches when the second pass can be parallel or gated.

If the slow part is primary database search, do not tune Mem0 for three hours and call it science.

## Useful Commands

Run the smoke checks from the repository root:

```bash
node scripts/smoke/check-memory-health.mjs
node scripts/smoke/check-dashboard-keyword-search.mjs
node scripts/smoke/no-private-leak-check.mjs
node scripts/evals/recall-baseline.mjs
```

Each script documents its required environment variables when run without enough configuration.

## File Map

- `scripts/smoke/check-memory-health.mjs` checks the memory API health, recent rows, and optional stats endpoint.
- `scripts/smoke/check-dashboard-keyword-search.mjs` checks dashboard search copy and optional authenticated search behavior.
- `scripts/smoke/no-private-leak-check.mjs` scans the template for obvious private paths, secrets, and configurable private terms.
- `scripts/evals/recall-baseline.mjs` runs a fixed query set against either a Memory Steward endpoint or a raw search endpoint.
- `templates/closeout.md` captures what changed, proof, caveats, and operator action.
- `templates/gate-report.md` separates quality, speed, safety, and deployment readiness.
- `templates/rollout-report.md` records staged rollout state without pretending preview equals live.
- `templates/prime-radiant-board-readiness.md` checks board views, evidence quality, stale rows, and denominator boundaries.
- `templates/prime-radiant-lane.md` records one plan lane, owner, gate, proof, assignment state, rollback, and next action.
- `templates/prime-radiant-writeback-report.md` captures assignment write-back request, receipts, replay, rollback, and safety proof.
- `prompts/` contains role prompts for builder, reviewer, steward, and hygiene passes.
- `prompts/prime-radiant-reviewer.md` checks Prime Radiant board and write-back changes without blending gates.
