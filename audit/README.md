# Decay Audit

Replays a fixed set of canonical `memory_query` calls every week, snapshots the cited memory IDs, and diffs against the previous run to flag retrieval drift.

## Why

Raw semantic recall drifts as the memory bank grows. A query that correctly returned memory `abc12345` in April might return a near-miss six months later as new embeddings crowd the neighborhood. Memory Steward's reasoning traces are already logged by Anthropic per session, so the audit just needs to replay canonical queries and compare outputs over time.

## What it does

1. Loads `audit/canonical-queries.json` (a fixed list of questions you want the system to answer the same way every time).
2. For each query, hits `POST /memory/query` on your Memory Steward endpoint.
3. Extracts the memory IDs cited in the synthesized answer.
4. Writes a timestamped snapshot to `audit/results/YYYY-MM-DD.json`.
5. Diffs the new snapshot against the previous one and prints a Jaccard overlap + per-query added/removed IDs.

## Run it locally

```bash
export MEMORY_MCP_URL="https://your-mcp-server"
export MEMORY_MCP_TOKEN="your-bearer-token"
node audit/decay-audit.js
```

## Run it on a schedule

See `.github/workflows/decay-audit.yml` — runs every Monday morning, commits the new snapshot back to `main`, and fails the job if a query returns an error (so GitHub surfaces it in your notifications).

Set two repo secrets:

- `MEMORY_MCP_URL` — base URL of your Memory Steward HTTP endpoint
- `MEMORY_MCP_TOKEN` — bearer token for the endpoint

## Customize the queries

Edit `canonical-queries.json`. Pick questions whose answers shouldn't change week to week — things like rules, architectural concepts, deploy procedures. Don't include questions whose answers legitimately evolve (roadmap status, recent activity) — those will flag as false-positive drift.

## Interpreting drift

- **Jaccard 1.0** — identical memory IDs cited. No drift.
- **Jaccard 0.5 to 0.9** — partial overlap. Worth a look. New memory may have been added that's more relevant, or a stale one may have crept in.
- **Jaccard 0.0 to 0.5** — significant drift. Investigate: did the canonical memory get deleted? Did a new embedding outrank it? Did the Steward reformulate the query differently?
