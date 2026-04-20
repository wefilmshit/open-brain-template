# SessionStart Auto-Load Hook

Add this hook to `~/.claude/settings.json` and Claude Code will inject your N most recent memories into every session's starting context. No more "what are we working on" amnesia at the top of every conversation.

## What it does

At the start of every Claude Code session, the hook:
1. Hits your MCP memory server
2. Pulls the N most recent memories (default 20)
3. Formats them as a tight bullet list with category, date, ID prefix, summary
4. Returns them as `additionalContext` so they appear at the top of Claude's view

The model literally starts the conversation already knowing what happened in your last session.

## Setup

### Step 1: Save the hook script

Save as `~/.claude/hooks/session-start-memory.sh`:

```bash
#!/bin/bash
# SessionStart hook: load N most recent memories into Claude Code's
# starting context. Calls a personal-memory MCP server via the standard
# MCP handshake (initialize -> notifications/initialized -> tools/call).
#
# Auth: BOLT_MEM_TOKEN env var (sourced from ~/.your-keys via .zshrc).
# Failure mode: silent — if anything fails, output an empty hookSpecificOutput
# so the session still starts cleanly.

set -u

# Source your env file if it exists, so the token is available regardless
# of whether Claude Code inherits the interactive shell env.
[ -f "$HOME/.your-keys" ] && . "$HOME/.your-keys" 2>/dev/null

LIMIT="${MEMORY_HOOK_LIMIT:-20}"
URL="${MEMORY_MCP_URL:-https://your-mcp-server.example.com/mcp}"
TOKEN="${BOLT_MEM_TOKEN:-}"
LOG="/tmp/session-start-memory.log"

emit_empty() {
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}'
  exit 0
}

json_escape() {
  python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'
}

[ -z "$TOKEN" ] && emit_empty

HEADERS_FILE="$(mktemp)"
trap 'rm -f "$HEADERS_FILE"' EXIT

# Step 1: initialize, capture session id from headers
INIT_BODY='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"claude-code-session-start","version":"1.0.0"}}}'
curl -sS --max-time 8 -D "$HEADERS_FILE" -o /dev/null -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$INIT_BODY" >> "$LOG" 2>&1 || emit_empty

SESSION_ID=$(grep -i '^mcp-session-id:' "$HEADERS_FILE" | tail -1 | sed 's/.*: //' | tr -d '\r\n ')
[ -z "$SESSION_ID" ] && emit_empty

# Step 2: notifications/initialized — required by MCP spec before tool calls
curl -sS --max-time 5 -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  -o /dev/null >> "$LOG" 2>&1 || true

# Step 3: tools/call recent_memories
CALL_BODY=$(printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recent_memories","arguments":{"limit":%d}}}' "$LIMIT")
RAW=$(curl -sS --max-time 12 -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d "$CALL_BODY" 2>>"$LOG")

[ -z "$RAW" ] && emit_empty

# Server responds in SSE form: lines beginning with "event: " and "data: "
DATA_LINE=$(echo "$RAW" | grep -E '^data: ' | head -1 | sed 's/^data: //')
[ -z "$DATA_LINE" ] && emit_empty

# response.result.content[0].text holds a JSON string of {memories:[...]}
FORMATTED=$(echo "$DATA_LINE" | python3 -c '
import json, sys
try:
  outer = json.loads(sys.stdin.read())
  text = outer["result"]["content"][0]["text"]
  inner = json.loads(text)
  mems = inner.get("memories", [])
  if not mems:
    print("(no recent memories)")
    sys.exit(0)
  lines = ["Recent memories (most recent first):", ""]
  for m in mems:
    summary = (m.get("summary") or m.get("content") or "")[:200]
    cat = m.get("category", "?")
    created = (m.get("created_at") or "")[:10]
    mid = m.get("id", "?")[:8]
    lines.append(f"- [{cat}] {created} ({mid}): {summary}")
  print("\n".join(lines))
except Exception as e:
  print(f"(memory parse failed: {e})")
')

ADDITIONAL_CONTEXT_JSON=$(printf '%s' "$FORMATTED" | json_escape)
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' "$ADDITIONAL_CONTEXT_JSON"
```

Make it executable:

```bash
chmod +x ~/.claude/hooks/session-start-memory.sh
```

### Step 2: Add your MCP token to your env file

Add a line to whatever file `.zshrc` (or `.bashrc`) sources for your secrets:

```bash
BOLT_MEM_TOKEN="your-mcp-server-bearer-token"
```

The hook script sources this automatically — you don't need to export it manually.

### Step 3: Add the hook to `~/.claude/settings.json`

Inside the top-level `hooks` object:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/session-start-memory.sh",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

### Step 4: Reload

Run `/hooks` in any Claude Code session, OR restart Claude Code. The settings watcher only picks up new hooks on those events.

## What you'll see

At the top of every new Claude Code session, you get a SessionStart additional-context block with your last 20 memories formatted like:

```
Recent memories (most recent first):

- [project] 2026-04-20 (c9aa5198): Architecture intent: replace Railway personal-memory-mcp-http wrapper with an Anthropic Managed Agent...
- [wfs] 2026-04-20 (fc8374d4): Primary working directory: ~/Documents/...
- [technical] 2026-04-20 (feb9b39e): Use frontend-design for UI and webapp-testing for end-to-end verification
- ...
```

Claude reads these as part of its starting context, so when you say "let's keep going on what we were doing yesterday," it actually knows.

## Tuning

- `MEMORY_HOOK_LIMIT` env var: change the number of memories pulled (default 20). 50 is reasonable for very active days.
- `MEMORY_MCP_URL` env var: point at a different MCP server.
- `timeout: 15` in settings.json: max seconds before Claude Code gives up on the hook and continues without it. The script's own --max-time on each curl ensures it never blocks even if Anthropic / your server is slow.

## Failure mode

The hook fails silent. If your MCP server is down, the token is missing, or anything else breaks, the script returns an empty `additionalContext` and the session starts as if no hook ran. Diagnostics go to `/tmp/session-start-memory.log`.

This means turning on the hook can never break a session. The worst case is "no auto-loaded memories this time."
