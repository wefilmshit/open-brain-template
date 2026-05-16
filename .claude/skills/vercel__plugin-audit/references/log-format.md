# Conversation Log Format

Claude Code stores conversation logs as JSONL files at:
```
~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
```

The encoded path replaces `/` with `-` and prepends a `-`. Example:
`/Users/john/dev/my-app` → `-Users-john-dev-my-app`

## JSONL structure

Each line is a JSON object with:

```json
{
  "type": "assistant" | "user" | "system",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "tool_use", "name": "Bash", "input": { "command": "..." } },
      { "type": "tool_use", "name": "Read", "input": { "file_path": "..." } },
      { "type": "tool_use", "name": "Write", "input": { "file_path": "..." } },
      { "type": "tool_use", "name": "Edit", "input": { "file_path": "..." } }
    ]
  },
  "timestamp": "ISO-8601"
}
```

## What's NOT in the log

- Hook return payloads (`hookSpecificOutput`) are NOT recorded in JSONL
- Only `hook_progress` events appear, showing that a hook was invoked
- To verify skill injection, test the hook directly against extracted tool inputs

## Extracting tool calls

Parse each line, check `message.content` for arrays containing `type: "tool_use"`, extract `name` and `input`. Filter for supported tools: Read, Edit, Write, Bash.

## Hook progress events

Look for lines containing `hook_progress` to see which hooks fired:
```json
{
  "hookEvent": "PreToolUse",
  "hookName": "PreToolUse:Bash",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse-skill-inject.mjs\""
}
```

## Subagent tool calls

Sessions using TeamCreate spawn subagents that run in worktree isolation. Their tool calls appear in the same log but may have different `cwd` values. Track `cwd` to distinguish main agent from subagents.
