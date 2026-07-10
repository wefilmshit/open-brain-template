# Open Brain Memory Server

A generic MCP server over the `memory-api` Edge Function. Stdio transport --
works with Claude Code, Claude Desktop, Cursor, or any MCP-compatible client.
No separate hosting required; it runs as a local subprocess your MCP client
starts and stops.

## Install

```bash
cd memory-server
npm install
cp .env.example .env
# edit .env: set MEMORY_API_URL and MEMORY_API_KEY from your deployed
# supabase/functions/memory-api (see ../supabase/README.md)
```

## Wire it into an MCP client

**Claude Code / Claude Desktop** (`.mcp.json` or the equivalent client config):

```json
{
  "mcpServers": {
    "open-brain-memory": {
      "command": "node",
      "args": ["/absolute/path/to/memory-server/server.mjs"],
      "env": {
        "MEMORY_API_URL": "https://your-project.supabase.co/functions/v1/memory-api",
        "MEMORY_API_KEY": "your-memory-api-key"
      }
    }
  }
}
```

**Cursor**: same shape, under Cursor's MCP settings.

Environment variables can be set in the client config's `env` block (as
above) or via a real `.env` file next to `server.mjs` -- either works.

## Tools

| Tool | Purpose |
|---|---|
| `remember` | Store a memory. Accepts content-only or summary-only (derives + flags the other). |
| `recall` | Search, capped to a bounded result size. Optional `embedding` for vector search. |
| `recent_memories` | List recent memories. |
| `forget` | Permanent delete. |
| `memory_correct` | Update in place, preserving prior text in history. Re-mirrors Mem0 if enabled. |
| `memory_archive` | Move to the restorable archive shelf. Purges the Mem0 mirror if enabled. |
| `memory_restore` | Restore from the archive shelf. |
| `memory_stats` | Exact total + category/source breakdown. |

Every tool is a thin wrapper over `memory-api`'s HTTP routes (see
`lib/memory-api-client.mjs`) -- the actual logic (dedup, cap, archive) lives
server-side in the Edge Function so the dashboard and any other client get
the same guarantees without going through this server.

See `../docs/self-hosting-fixes.md` for why each tool behaves the way it
does, especially `remember`'s tolerance behavior and the Mem0 `infer:false`
trade-off.

## Run it standalone (for testing)

```bash
node --env-file=.env server.mjs
```

It logs `open-brain-memory-server running on stdio` to stderr and then waits
for MCP protocol messages on stdin. Ctrl-C to stop. This is mainly useful to
confirm your `.env` is valid before wiring it into a client -- an MCP client
will start/stop this process for you in normal use.

The standalone command uses Node's built-in `.env` loader (Node 20.6+). MCP
client wiring remains compatible with older supported Node versions because
the client injects the variables through its local `env` configuration.
