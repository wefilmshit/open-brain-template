# Memory Steward Setup

Memory Steward is an Anthropic Managed Agent that wraps your raw memory bank in a smart query layer. Instead of returning a list of semantic matches, it returns one synthesized answer with cited memory IDs, after re-ranking and filtering.

This guide walks through creating the agent and standing up the orchestrator that drives its sessions.

## Prerequisites

- Open Brain dashboard already deployed (see main [README](../README.md))
- An MCP server in front of your memory bank (the `personal-memory-mcp-http` pattern, or your own)
- An Anthropic API key with access to Managed Agents (beta as of April 2026)
- Whatever runtime hosts your MCP server (this template assumes Railway, but Fly / Render / Vercel Edge / a tiny VPS all work)

## Step 1: Create the Managed Agent

The agent definition is a system prompt plus 5 custom tools. The agent calls those tools, an orchestrator (your code) executes them against your memory store, and the agent returns a synthesized answer to whoever called it.

Save this as `create-memory-steward.json`:

```json
{
  "name": "Memory Steward",
  "description": "Smart query layer for an Open Brain memory bank. Reformulates queries, runs parallel searches, re-ranks results, dedup-checks before saving.",
  "model": "claude-sonnet-4-5",
  "system": "You are Memory Steward, curator of YOUR_NAME's personal memory bank.\n\nJOB: when called by another Claude session, find the right memories, judge their relevance, and return only what actually matters. The bank holds N entries. Most queries return some semantic match, but most matches are noise. Your value is filtering noise out.\n\nRESPONSIBILITIES:\n1. Smart recall. When asked to recall, look at the surface query AND any hint about the caller's actual task. Reformulate for better embedding matches. Cast multiple parallel queries when one phrasing is not enough. Re-rank raw results by relevance to the actual task, not raw semantic similarity.\n2. Filter ruthlessly. Drop memories that are stale, duplicate, contradicted by newer ones, or off-topic. Better to return three tight matches than ten noisy ones.\n3. Dedup-check before saving. Before calling remember, ALWAYS run recall_smart with the new memory's summary to check for a similar existing entry. If found, do not save unless the new one adds material info.\n4. Honest stewardship. If nothing relevant exists, return that plainly. Never fabricate.\n\nTOOL USAGE:\n- recall_smart(query, hint?, category?, limit?) - semantic search with re-ranking. Default limit 10. Use multiple parallel calls with different query phrasings when one query is not enough.\n- recent(limit?, category?) - last N memories chronologically.\n- remember(content, summary, category, tags?) - save. ALWAYS dedup-check first.\n- forget(id) - delete. Only when explicitly authorized.\n- stats() - bank metadata.\n\nCATEGORIES:\n- Customize this list to match the categories you use in your memory store.\n\nWORKING STYLE:\n- Caller-facing summaries: tight, no walls of text, no em dashes, no emoji.\n- Cite memory IDs (first 8 chars in parentheses) so the caller can reference specific entries.\n- For recall results, lead with one short header sentence then a bullet per memory: [category] (id-prefix) summary.\n- For remember, confirm the new ID and explicitly flag if you skipped a save due to dedup.\n- For stats, structured count summary.\n- No filler.",
  "tools": [
    {
      "type": "custom",
      "name": "recall_smart",
      "description": "Semantic search of the memory bank with smart query reformulation and re-ranking. Use for any 'find what we know about X' question.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "hint": { "type": "string" },
          "category": { "type": "string" },
          "limit": { "type": "number" }
        },
        "required": ["query"]
      }
    },
    {
      "type": "custom",
      "name": "recent",
      "description": "Return the N most recently stored memories chronologically.",
      "input_schema": {
        "type": "object",
        "properties": {
          "limit": { "type": "number" },
          "category": { "type": "string" }
        }
      }
    },
    {
      "type": "custom",
      "name": "remember",
      "description": "Store a new memory. ALWAYS dedup-check first via recall_smart.",
      "input_schema": {
        "type": "object",
        "properties": {
          "content": { "type": "string" },
          "summary": { "type": "string" },
          "category": { "type": "string" },
          "tags": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["content", "summary", "category"]
      }
    },
    {
      "type": "custom",
      "name": "forget",
      "description": "Delete a specific memory by UUID.",
      "input_schema": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"]
      }
    },
    {
      "type": "custom",
      "name": "stats",
      "description": "Get memory bank statistics.",
      "input_schema": { "type": "object", "properties": {} }
    }
  ]
}
```

Then create the agent:

```bash
curl -X POST https://api.anthropic.com/v1/agents \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01" \
  -H "content-type: application/json" \
  --data-binary @create-memory-steward.json
```

Save the returned `id` — that's your `MEMORY_STEWARD_AGENT_ID`.

You also need a `MEMORY_STEWARD_ENVIRONMENT_ID`. Use one from your existing Anthropic Managed Agents setup, or create a new environment via the Anthropic console.

## Step 2: Add the orchestrator to your MCP server

The orchestrator is the thing that actually executes the agent's tool calls against your memory store. It sits in your existing MCP server (or runs alongside it) and:

1. Receives a memory_query request (HTTP or MCP tool call)
2. Creates a Memory Steward session
3. Sends the user's query as a message
4. Listens to the session's SSE event stream
5. When the agent emits `agent.custom_tool_use`, executes the tool against your memory store
6. POSTs `user.custom_tool_result` back into the session
7. Loops until the agent emits `end_turn`
8. Returns the agent's final synthesized text

A reference implementation in Node.js (~370 lines) lives at [orchestrator.js.example](orchestrator.js.example) in this repo. The pattern is mirrored from Anthropic's own production usage of Managed Agents — the unknown-event-id ack safeguard in particular is critical (without it, sessions hang on race conditions where SSE events arrive out of order).

The orchestrator needs three env vars:

- `ANTHROPIC_API_KEY` — your Anthropic key with Managed Agents access
- `MEMORY_STEWARD_AGENT_ID` — from Step 1
- `MEMORY_STEWARD_ENVIRONMENT_ID` — from Step 1

And one function reference: a `callMemoryAPI(path, method, body)` helper that talks to your memory store (Supabase memory-api edge function in this template, or your own equivalent).

## Step 3: Expose memory_query to MCP clients

Add a 6th tool to your existing MCP server's tool list:

```js
{
  name: "memory_query",
  description: "Smart memory query via Memory Steward Managed Agent. Returns one synthesized answer with cited memory IDs.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      hint: { type: "string" }
    },
    required: ["query"]
  }
}
```

And the handler:

```js
case "memory_query": {
  const stewardResult = await runStewardQuery({
    query: args.query,
    hint: args.hint,
    callMemoryAPI
  });
  return { content: [{ type: "text", text: JSON.stringify(stewardResult) }] };
}
```

## Step 4: Use it from any MCP client

In Claude Code:

```
Use mcp__personal-memory__memory_query to find our deploy procedure.
```

In a script:

```bash
curl -X POST https://your-mcp-server/memory/query \
  -H "Authorization: Bearer $YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"what is our deploy procedure","hint":"about to push a frontend change"}'
```

You'll get back something like:

```json
{
  "ok": true,
  "response": "Found one definitive guide (1b69a410).\n\n[technical] (1b69a410) Deploy via git push to main, NEVER use the prod CLI...",
  "session_id": "sesn_...",
  "iterations": 3,
  "tool_calls": [...],
  "duration_ms": 31606
}
```

## Cost considerations

Each `memory_query` call spins up a Managed Agent session (Sonnet 4.5 by default). Typical session: 3 iterations, 5-6 tool calls, ~30s wall time. Use raw `recall` when you just need bulk results — keep `memory_query` for questions where one synthesized answer is more valuable than ten raw matches.

## What the agent looks like once running

```
your-mcp-server: tool memory_query called
  → Memory Steward session created (sesn_xxx)
  → Sent user message
  → Agent emitted 3 parallel recall_smart calls
    → orchestrator executed each against memory-api
    → posted results back
  → Agent emitted 2 more recall_smart calls (refining)
    → orchestrator executed, posted back
  → Agent emitted end_turn with synthesized response
  → orchestrator deleted session, returned response
your-mcp-server: tool memory_query returned (32s, 5 tool calls, 3 iterations)
```
