# Give This Repo to Your AI

Use this when you want Claude, ChatGPT, Cursor, or another AI assistant to help you set up Open Brain without guessing what the repo is for.

Copy the prompt below into your assistant and point it at this repository.

```text
You are helping me set up Open Brain, an open-source AI agent memory dashboard and MCP-compatible memory template.

Repository:
This repository.

Read these first:
1. README.md
2. CLAUDE.md
3. docs/optimization-kit.md
4. docs/memory-file-sync.md, only if I ask for local markdown file sync
5. docs/memory-steward.md, only if I ask for an advanced smart-query layer

Goal:
Help me install a persistent AI memory system that works with Claude, ChatGPT, Cursor, or another MCP-compatible assistant.

Keep these boundaries:
- The dashboard keyword search is not automatically semantic search.
- Agent recall can use semantic retrieval through the memory API and pgvector.
- Memory Steward is optional and advanced.
- Memory File Sync Kit is optional and advanced.
- Do not invent private credentials, private deployment names, or private memory categories.
- Ask me for missing Supabase, auth, deployment, or MCP details instead of guessing.

First output:
Give me a short setup checklist for my exact environment. Then ask only the missing questions needed to start.
```

## What Open Brain Includes

- A browser dashboard for viewing, editing, and grouping memory rows.
- Priority-based memory files so agents know what to load first.
- A memory API pattern for MCP-compatible assistants.
- Supabase and pgvector as the public template's source-of-truth path.
- Optional Mem0 support for memory compression, deduplication, and ranking.
- Optional Memory Steward docs for smarter query reformulation and result synthesis.
- Optional Memory File Sync Kit scripts for people who want local markdown memory files.
- An Optimization Kit with smoke checks, evals, prompts, and handoff templates.

## What Open Brain Does Not Claim

- It does not make every dashboard search semantic by default.
- It does not ship with your private memories, categories, or credentials.
- It does not auto-enable local file sync, schedulers, or advanced steward services.
- It does not replace your judgment about what memories are stale, private, or safe to publish.

## Beginner Path

1. Read `README.md`.
2. Read `CLAUDE.md`.
3. Create a Supabase project.
4. Put your Supabase URL and anon key into `index.html`.
5. Configure allowed emails.
6. Deploy the dashboard.
7. Add the MCP memory path your assistant will use.
8. Run the smoke checks in `docs/optimization-kit.md`.

## Advanced Path

Use the beginner path first. Then add only the optional kit you need:

- Use `docs/memory-file-sync.md` when you want local markdown files to mirror Open Brain `memory-file` rows.
- Use `docs/memory-steward.md` when you want smarter recall over raw search results.
- Use `scripts/evals/recall-baseline.mjs` when you need repeatable quality checks.
- Use `templates/gate-report.md` and `templates/closeout.md` when multiple people or agents are reviewing changes.

## Search Terms

People usually find this project through terms like:

- AI agent memory
- MCP memory
- Claude Code memory
- ChatGPT memory
- Cursor memory
- persistent AI memory
- Supabase pgvector memory
- semantic recall
- keyword search recent memories
- memory dashboard
- MCP memory dashboard
- Open Brain Optimization Kit
- Memory File Sync Kit
- memory file sync
- Mem0 memory
- Open Brain
