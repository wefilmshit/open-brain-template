---
name: wfs-plan-continuity
description: Use when Tony asks for a plan, implementation plan, "where are we", "resume", "continue", "pick back up", "drift", "handoff", "cross-check", "checkpoint", or when work might overlap an existing plan. Also use when starting a new session and there's any chance the work touches an existing canonical plan. Forces inspection of existing plans before drafting a new one, and enforces the CURRENT CURSOR convention so paused work is not lost across sessions.
---

# WFS Plan Continuity

## Why this skill exists

Across Claude/Codex sessions, agents keep creating new plan files when an active canonical plan already covers the work. They forget paused lanes during detours and never come back. They lose track of which session+agent is on the hook for which lane. The result is plan sprawl, lost work, and Tony having to remember everything himself.

This skill enforces a CURRENT CURSOR convention. Every active canonical plan starts with a cursor block that names where the work is right now, who owns it, and what the next action is. Agents read the cursor before starting work and write to it before finishing.

The convention runs on top of any agent (IPE ICE Claude, IPE ICE Codex, AAA Claude, AAA Codex) so all four can coordinate on the same canonical plans without stepping on each other.

## When to invoke this skill

Invoke FIRST, before drafting or editing any plan file, when:
- Tony asks for a plan, implementation plan, design doc, or roadmap.
- Tony says "where are we", "resume", "continue", "pick back up", or "what's next".
- Tony says "drift", "handoff", "cross-check", or "checkpoint".
- A session is starting and the user message references an existing project, branch, or feature area (anything that might overlap an existing plan).
- An agent is about to write to or supersede a plan file.
- An agent is finishing a lane and a cross-check is about to be requested from another agent.

Skip ONLY when the work is clearly an isolated one-off note, a prompt-relay file, or pure documentation that has no active execution lane.

## The four steps

### Step 1: Inspect existing plans before writing anything new

List the plan directories:
- `/Users/tonyfinley/.claude/plans/` (master plans + cross-project plans)
- `/Users/tonyfinley/Documents/WFS-Anthropic-Master/WFS-bolt/.claude/plans/` (WFS-bolt repo plans)

For any plan whose filename or top-of-file content overlaps the work the agent is about to do, read the CURRENT CURSOR block at the top.

If a CURRENT CURSOR exists and the plan's `Status` is `Active` or `Paused`, the agent considers resume vs new per Step 2 — but does NOT just trust the cursor. Stale-cursor handling per Step 3 applies first.

If multiple plans look like candidates, list them for Tony and let him pick.

### Step 2: Decide resume vs supersede vs new

Decision rule:

| Existing plan's status | Action |
|---|---|
| `Active` and scope matches | **Resume** — update the cursor, keep working in the existing plan. |
| `Paused` and scope matches AND the `Resume after` gate is satisfied | **Resume** — update the cursor with new status, keep working in the existing plan. |
| `Paused` and scope matches BUT the `Resume after` gate is NOT yet satisfied | **Blocked** — do NOT resume execution. Either ask Tony for an explicit unblock, or update the cursor with the current blocker observation and halt. The plan stays Paused. |
| `Superseded` | Follow the supersession link to the newer plan; treat that as the active one. |
| `Shipped` or `Standalone-historical` | Don't write here. Either resume the parent plan or create a new plan. |
| No matching plan exists | **New** — create a new plan and immediately write a CURRENT CURSOR block. |
| Tony explicitly forks or supersedes | **New + supersede** — create a new plan, mark the old as `Superseded`, link both ways. |

When in doubt, ask Tony before writing.

### Step 3: Write or update the cursor — and check it for staleness first

Use the format in `/Users/tonyfinley/.claude/plans/CURRENT-CURSOR-TEMPLATE.md`. The required fields:

- **Status** — `Active | Paused | Superseded | Shipped | Standalone-historical`
- **Owned by** — comma-separated list using the strict per-lane shape `<Agent> (lane: <name>, status: <state>)`. Canonical agent identifiers: `IPE ICE Claude`, `IPE ICE Codex`, `AAA Claude`, `AAA Codex`, `Tony`. One entry per agent per lane. Lane status values: `active | blocked | paused | review | done | pending`.
- **Current checkpoint** — one short sentence on the active piece of work
- **Last completed** — most recent durable milestone (concrete, with a marker)
- **Next action** — imperative-phrased next concrete step
- **Paused lanes** — comma-separated short labels of work on hold
- **Resume after** — the testable gate that unfreezes paused lanes
- **Owned branch** — git branch(es) holding in-flight work; `n/a` if none
- **Latest evidence** — one or two paths to the freshest proof of the last completed item
- **Updated at** — ISO 8601 UTC timestamp
- **Updated by** — same vocabulary as Owned by (single agent identifier)

Update the cursor:
- After every checkpoint or named milestone
- Before leaving the plan for a detour (capture the detour + return point)
- When returning from a detour, before resuming work
- When supersession happens (link both ways)
- Whenever the `Next action` would otherwise grow stale

#### Stale-cursor fallback (mandatory check before trusting any cursor)

A cursor is the source of truth ONLY if it is current. Before relying on it, run a freshness check:

1. **Read the cursor** including `Updated at`.
2. **If `Updated at` is missing, more than one working day stale, or contradicted by available evidence, do NOT trust the cursor blindly.**
3. **Inspect recent evidence:**
   - `git log --since=<cursor's Updated at>` on the plan's `Owned branch` and on `origin/overhaul-v1` (or whatever the relevant base is)
   - `WFS-bolt/artifacts/ai-chatboard/` for fresh artifacts mentioning the plan's task IDs or scope
   - Recent memories via `recall` for milestones, checkpoints, or detours that contradict the cursor
   - PR / merge state on GitHub for the owned branch
4. **If reality disagrees with the cursor, do not silently resume.** Report the drift to Tony, propose a corrected cursor (either as inline text or a draft file at `/tmp/`), and wait for approval before applying.
5. **If reality matches the cursor, refresh `Updated at` and `Updated by` to the current session/agent and proceed.**

The cursor never overrides observed reality. It is a starting point for orientation; evidence wins ties.

### Step 4: Multi-agent coordination

When more than one agent (any of IPE ICE Claude, IPE ICE Codex, AAA Claude, AAA Codex) is working on the same plan:

- The `Owned by` field uses the strict per-lane shape: one entry per agent per lane, e.g.
  ```
  IPE ICE Codex (lane: CD finish, status: active),
  IPE ICE Claude (lane: drift skill, status: review),
  Tony (lane: deploy auth, status: pending)
  ```
- Two agents on the SAME lane is a coordination signal — only acceptable when an explicit cross-check or simultaneous-apply window is in flight, and the `Next action` field describes how the two agents synchronize.
- Each agent updates only the lane entries they own. They do NOT rewrite other agents' lane entries.
- When an agent picks up a paused lane that another agent had owned, they update the `Owned by` entry for that lane to themselves (the prior owner moves to `done` or is removed if fully off the lane).
- If two agents need to coordinate a single action (e.g. a simultaneous-apply window like Window 1), the cursor's `Next action` says so explicitly, and the lane entries reflect both agents with `status: active`.

The cursor is the source of truth for "who's on the hook." If it disagrees with the agent's intent, stop and reconcile before writing code.

## What NOT to do

- Do not create a new plan file when an existing plan already covers the work and is `Active` or `Paused` (subject to the paused-gate rule in Step 2).
- Do not silently abandon a plan. Use `Superseded` with a back-link.
- Do not skip the cursor on the assumption that the plan body says enough. The cursor IS the source of truth for "where are we now."
- Do not write detail in the cursor that belongs in the plan body. Cursor is one-line-per-field, terse. Long lists (e.g. an enumeration of every active sub-plan) belong in an audit artifact the cursor points at, not inside the cursor itself.
- Do not auto-edit canonical plans without human review. The cursor convention is for agents to update their own state; rewriting plan content broadly still needs Tony's call.
- Do not blindly resume a paused plan. The `Resume after` gate must be satisfied or Tony must explicitly unblock; otherwise report blocked and halt.
- Do not blindly trust a cursor whose `Updated at` is stale or contradicted by evidence. Run the freshness check in Step 3.

## Why this convention before automation

A `wfs-plan-sync context` CLI/MCP tool that recommends `resume_existing_plan | update_existing_plan | create_new_plan` is the eventual automation. But automation requires a stable convention to read against. Ship the convention first, run it across at least two real WFS sessions (one normal resume, one detour/resume), and only build the CLI/MCP tool if the manual convention fails or becomes tedious.

This convention ships now. Automation is a future slice, not blocked by this skill but downstream of it.

## Reference

- Template: `/Users/tonyfinley/.claude/plans/CURRENT-CURSOR-TEMPLATE.md`
- Origin discussion: §21.10 of `/Users/tonyfinley/.claude/plans/2026-04-27-ipe-search-unified-plan.md`
- Council artifact: `/Users/tonyfinley/Documents/WFS-Anthropic-Master/WFS-bolt/artifacts/ai-chatboard/research-augmented-loop-council_20260501T232706Z.md`
