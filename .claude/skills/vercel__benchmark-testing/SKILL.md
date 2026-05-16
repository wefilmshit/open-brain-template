---
name: benchmark-testing
description: Create and launch benchmark test projects to exercise vercel-plugin skill injection across realistic scenarios. Sets up isolated directories, installs the plugin, and spawns WezTerm panes running Claude Code with crafted prompts.
---

# Benchmark Testing

Create isolated test projects that exercise vercel-plugin skill injection with realistic, technology-agnostic prompts.

## Workflow

### 1. Create test directories

```bash
BASE=~/dev/vercel-plugin-testing
mkdir -p "$BASE"/{01-slug,02-slug,...}
```

### 2. Install the plugin in each directory

```bash
for dir in "$BASE"/*/; do
  echo "=== $(basename "$dir") ==="
  cd "$dir" && npx add-plugin https://github.com/vercel/vercel-plugin -s project -y 2>&1 | tail -1
done
```

This creates `.claude/settings.json` with `enabledPlugins` in each directory.

### 3. Launch Claude Code in WezTerm panes

**Critical details that must all be followed:**

- Use `--cwd <absolute-path>` to set the working directory
- Use `unset CLAUDECODE` before `x` to avoid nested-session errors
- Use `--settings .claude/settings.json` (not `--settings project`) to load the plugin
- Use double quotes on the outer `-ic` string, single quotes around the prompt
- Wait **10 seconds** between each launch to avoid overwhelming the system
- Always use `spawn` (new tabs) — `split-pane` runs out of space after ~4 panes

**Working command template:**

```bash
wezterm cli spawn --cwd /absolute/path/to/test-dir -- /bin/zsh -ic "unset CLAUDECODE; x 'YOUR PROMPT HERE. Link the project to my vercel-labs team so we can deploy it later.' --settings .claude/settings.json; exec zsh"
```

## Prompt Guidelines

- **Never name specific technologies** (no "Next.js", "Stripe", "Vercel KV", etc.)
- Describe the *product* and *features* — let the plugin infer which skills to inject
- Make prompts ambitious and multi-featured to exercise multiple skill triggers
- Always append: "Link the project to my vercel-labs team so we can deploy it later."

### Example prompts

| Slug | Prompt | Expected skills |
|------|--------|----------------|
| recipe-platform | "Build a recipe sharing platform where users sign up, upload photos of their dishes, write ingredients and steps, and browse a feed with infinite scroll..." | auth, vercel-storage, nextjs |
| trivia-game | "Create a multiplayer trivia game where players join a room with a 6-letter code, answer questions in real-time with a 15-second countdown..." | vercel-storage, nextjs |
| code-review-bot | "Build an AI-powered code review dashboard with webhook API routes, LLM streaming analysis, and stats over time..." | ai-sdk, nextjs |
| conference-tickets | "Create a conference ticketing system with tiered checkout, QR code emails, admin panel, and payment webhook handling..." | payments, email, auth |
| content-aggregator | "Build a content aggregator with hourly scheduled RSS fetching, LLM summaries, category filters, and bookmarks..." | cron-jobs, ai-sdk |
| finance-tracker | "Build a personal finance tracker with bank connection, spending charts, and weekly email digest via scheduled job..." | cron-jobs, email |
| multi-tenant-blog | "Create a multi-tenant blog where each user gets a subdomain, with request-level routing, headless content API, and role-based auth..." | routing-middleware, cms, auth |
| status-page | "Build a SaaS status page with scheduled endpoint pinging, uptime charts, incident logging, and KV-stored history..." | cron-jobs, vercel-storage, observability |
| dog-walking-saas | "Build a dog walking SaaS with user accounts, pet photos, booking, monthly invoicing, admin dashboard, and separate dev/prod env configs..." | payments, auth, vercel-storage, env-vars |

## Cleanup

```bash
rm -rf ~/dev/vercel-plugin-testing
```
