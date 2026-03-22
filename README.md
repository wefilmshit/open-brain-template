# Open Brain Dashboard

A visual brain map for AI memory systems. See your entire memory hierarchy at a glance, search semantically, edit inline, and manage priority-based loading rules.

Built on Supabase + Vercel. Works with Claude Code, Claude Desktop, ChatGPT, or any MCP-compatible AI tool.

![Brain Map](https://img.shields.io/badge/memories-263-purple) ![Auth](https://img.shields.io/badge/auth-Google_OAuth-blue) ![Deploy](https://img.shields.io/badge/deploy-Vercel-black)

## Screenshots

### 🧠 Brain Map — Visual Memory Hierarchy
![Brain Map](brain-map.png)

### ✏️ Editor — Priority-Based Memory Files
![Editor](editor.png)

## Features

**Brain Map** — Visual tree showing memory hierarchy across 3 tiers:
- Always Load (rules, recent context)
- Table of Contents (reference docs, runbooks, integrations)
- On-Demand (project, technical, personal memories by category)

**Semantic Search** — Find any memory by meaning, not just keywords

**Inline Editing** — Click any memory node to expand, edit, or delete

**Editor Tab** — Manage source-of-truth documents organized by load priority

**Google OAuth** — Secure login with email allowlist

**Priority Load Order** — P1 through P4 system tells AI agents what to read first

## Quick Start

1. Create a [Supabase](https://supabase.com) project
2. Clone this repo
3. Replace `YOUR_SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY` in `index.html`
4. Add your email to `ALLOWED_EMAILS`
5. Deploy to [Vercel](https://vercel.com)

Full setup instructions in [CLAUDE.md](CLAUDE.md) (readable by both humans and AI agents).

## Key Concepts

### Priority-Based Load Order
Not all memories are equal. Rules should load every session. Reference docs load when relevant. This system prevents AI context overload and ensures critical guardrails are never forgotten.

### The /refresh Pattern
Long AI sessions cause context drift — the agent "forgets" rules loaded at the start. The `/refresh` command forces re-reading of P1 rules mid-session without starting over.

### Session Start Checklist
A structured boot sequence for AI agents: load rules first, then recent context, then table of contents. Ask what we're doing. Load specifics on-demand.

## Stack
- Frontend: Vanilla HTML/CSS/JS (no build step, single file)
- Auth: Supabase Auth with Google OAuth
- Database: Supabase (Postgres + pgvector)
- Hosting: Vercel
- Memory Protocol: MCP (Model Context Protocol)

## Contributing
PRs welcome. If you build something cool on top of this, open a PR or issue.

## License
MIT
