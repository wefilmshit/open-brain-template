# Open Brain Dashboard

A visual brain map dashboard for AI memory systems. One database (Supabase), one protocol (MCP), any AI tool plugs in.

## What This Is
- Visual hierarchical tree of all memories organized by priority
- Google OAuth login
- Semantic search across all memories
- Inline edit/delete on every memory
- Editor tab for managing source-of-truth documents (rules, runbooks, specs)
- Priority-based load order (P1 rules, P2 reference, P3 runbooks, P4 integrations)

## Setup Instructions (for Claude Code to execute)

### Step 1: Supabase Project
- Create a Supabase project at https://supabase.com
- Enable Google OAuth in Authentication > Providers > Google
- Create a `memories` table with these columns:
  - `id` (uuid, primary key, default gen_random_uuid())
  - `content` (text)
  - `summary` (text)
  - `category` (text)
  - `source` (text)
  - `tags` (text[])
  - `metadata` (jsonb)
  - `embedding` (vector(768))
  - `created_at` (timestamptz, default now())
  - `updated_at` (timestamptz, default now())
- Enable RLS on the memories table
- Add RLS policy: allow authenticated users full access

### Step 2: Configure the Dashboard
- In `index.html`, replace `YOUR_SUPABASE_URL` with your Supabase project URL
- Replace `YOUR_SUPABASE_ANON_KEY` with your Supabase anon/public key
- Add your email to the `ALLOWED_EMAILS` array

### Step 3: Deploy to Vercel
- Push this repo to GitHub
- Connect to Vercel at https://vercel.com
- Deploy (zero config needed, it's static HTML + one API route)
- Add your custom domain if desired

### Step 4: Set Up MCP Memory Server
- Install the personal-memory MCP server for Claude Code
- Point it at your Supabase project
- Claude Code will now read/write memories that appear in this dashboard

## Architecture
- `index.html` — Single-file dashboard (HTML + CSS + JS, no build step)
- `api/memories.js` — Vercel serverless proxy to Supabase (handles auth)
- `vercel.json` — Route config

## Key Concepts

### Priority-Based Load Order
Memories are organized into tiers that AI agents should load in order:
- **P1 (Always Load):** Rules, guardrails, gotchas. Read every session before any work.
- **P2 (Reference):** Tech stack, pipeline, workflow docs. Read when working on related systems.
- **P3 (Runbooks):** How-to guides, specs, roadmap. Read before touching these systems.
- **P4 (Integrations):** Third-party setup docs. Read only when relevant.

### Session Start Checklist
AI agents should follow this order every session:
1. Load P1 rules (non-negotiable)
2. Load recent context (last session checkpoint)
3. Load table of contents (know what exists, don't read it all)
4. Ask what we're doing today
5. Load specific memories on-demand as topics come up

### The /refresh Pattern
Mid-session, context drift causes AI agents to forget rules. The `/refresh` command forces re-reading of P1 rules without starting a new session.
