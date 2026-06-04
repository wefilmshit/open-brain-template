# Prime Radiant Operating Board

Prime Radiant is the operating-board layer for Open Brain.

Open Brain gives agents memory. Prime Radiant shows the work moving through that memory system: plans, lanes, owners, evidence, gates, drift, assignment changes, write-back receipts, and rollback paths.

This is the full shareable Prime Radiant package. It includes the public model, staged implementation path, write-back architecture, safety rules, templates, and prompts. Replace the example endpoints, agents, plans, and storage paths with your own environment.

## What Prime Radiant Is

Prime Radiant is an AI-agent operating board.

It answers:

- Which agent owns this lane?
- Which plan is active?
- Which sub-plan is blocked?
- What proof exists?
- What gate is still unaccepted?
- What changed since the last checkpoint?
- Is this read-only proof, dry-run proof, deployed proof, or live-write approval?
- If an assignment changes, what receipt and rollback path prove it?

Prime Radiant should make work legible before it makes work automatic.

## Core Vocabulary

- **Open Brain** - the memory and dashboard layer.
- **Prime Radiant** - the operating board that visualizes work state.
- **Seldon Plan** - a durable plan or roadmap.
- **Chevron** - the current position marker inside a plan.
- **Splice** - a sub-plan, work lane, or branch under a larger plan.
- **Seldon Crisis** - a plan-vs-reality mismatch, stale evidence, or drift event.
- **Gate** - a decision boundary such as review, merge, deployed dry-run, live write, rollback, publish, or public claim.
- **Receipt** - a durable proof artifact, audit entry, or idempotency record.
- **Receiver** - the trusted server or local process that accepts validated write-back requests.

## What To Track

At minimum, Prime Radiant tracks these records.

### Agent

```json
{
  "id": "reviewer",
  "name": "Reviewer",
  "status": "available",
  "project_tags": ["open-brain"],
  "allowed_operations": ["review", "closeout"]
}
```

### Plan

```json
{
  "id": "open-brain-relaunch",
  "title": "Open Brain relaunch",
  "status": "active",
  "current_chevron": "s4-s5-public-template",
  "source_path": "plans/open-brain-relaunch.md"
}
```

### Splice

```json
{
  "id": "public-template-prime-radiant",
  "plan_id": "open-brain-relaunch",
  "title": "Prime Radiant public package",
  "status": "active",
  "owner_agent_id": "builder",
  "gate": "review"
}
```

### Gate

```json
{
  "id": "deployed-dry-run",
  "splice_id": "stage-3-writeback",
  "status": "pass",
  "denominator": "production endpoint returned 200 dry_run; ledger hash unchanged",
  "receipt_path": "artifacts/closeouts/stage-3-dry-run.md"
}
```

### Assignment Edge

```json
{
  "plan_id": "open-brain-relaunch",
  "splice_id": "stage-3-writeback",
  "agent_id": "reviewer",
  "role": "review",
  "status": "active",
  "created_at": "2026-06-04T00:00:00Z"
}
```

### Write-Back Receipt

```json
{
  "request_id": "req_123",
  "operation": "replace_lane_assignment",
  "mode": "dry_run",
  "result": "dry_run",
  "idempotency_key": "hash_of_canonical_request",
  "rollback": {
    "operation": "restore_lane_assignments",
    "plan_id": "open-brain-relaunch",
    "splice_id": "stage-3-writeback"
  }
}
```

## Agent Roster And Project Tags

Prime Radiant needs a roster before it can assign work.

The roster should include:

- agent id
- display name
- current availability
- project tags
- lane tags
- allowed operations
- current assignments

Example:

```json
[
  {
    "id": "builder",
    "name": "Builder",
    "status": "available",
    "project_tags": ["open-brain", "frontend"],
    "allowed_operations": ["draft", "build", "closeout"]
  },
  {
    "id": "reviewer",
    "name": "Reviewer",
    "status": "available",
    "project_tags": ["open-brain", "readability"],
    "allowed_operations": ["review", "gate-report"]
  }
]
```

The public pattern is agent roster plus project tags. Your private wake engine, calendar, inbox, or routing system is optional implementation detail.

## Memory Red-Team And Seldon Crisis Guard

Prime Radiant should show drift and safety problems, not only green rows.

Use a Memory Red-Team or Seldon Crisis Guard to surface:

- stale memories
- duplicate memories
- contradictory memories
- bad recall results
- missing evidence
- stale Chevrons
- plan rows that cannot be checked
- claims that blend dry-run proof with live-write approval
- unsafe promotion from evidence to confirmed memory

Recommended stages:

1. **Observe-only** - detect and log possible issues. Do not block or mutate.
2. **Park or block** - after measured false-positive rates are acceptable, prevent unsafe memory or plan state from loading as trusted context.
3. **Repair proposal** - create a human-reviewable proposal with target, reason, proof, and rollback.
4. **Approved write** - only after an operator accepts the proposal.

Do not jump from "we detected a problem" to "the system is allowed to rewrite memory." That sentence is small. So is the fuse.

## Board Views

Build Prime Radiant around these views.

1. **Map view** - plans, splices, agents, and assignment edges.
2. **Lane view** - one splice with owner, gate, latest proof, blockers, and next action.
3. **Gate view** - review, merge, deploy, dry-run, live-write, rollback, and publish status.
4. **Receipts view** - closeouts, gate reports, write-back receipts, audit entries, and rollback objects.
5. **Crisis view** - stale Chevrons, missing evidence, broken anchors, and contradictory state.
6. **Roster view** - agents, project tags, availability, allowed operations, and current assignments.

## Implementation Stages

Prime Radiant is one system, but it should be implemented in staged gates so write authority is never accidental.

### Stage 1: Read-Only Board

Read plans, Chevrons, agents, splices, gates, artifacts, and assignments.

Rules:

- No mutation.
- No browser-to-database writes.
- No browser-to-plan-file writes.
- Missing evidence shows as `can't check`, not as fake green.

Stage 1 proves visibility.

### Stage 2: Interactive Picture

Allow drag, connect, reorder, filter, and draft assignment changes.

Rules:

- Draft changes do not write to the real ledger.
- Every proposed change must produce a preview diff.
- Every preview must show rollback intent.
- UI state must not be confused with system state.

Stage 2 proves operator ergonomics.

### Stage 3: Write-Back

Allow a validated operation to update real assignment state through a trusted receiver.

Rules:

- Live writes default off.
- Dry-run defaults on.
- Only allowlisted operations are accepted.
- Every write has an intent receipt before mutation.
- Every accepted write has an audit receipt after mutation.
- Every replay is idempotent.
- Every accepted operation has a rollback object.
- Bulk-shaped payloads are rejected unless explicitly designed and separately gated.
- Browser clients do not write directly to the database or plan files.

Stage 3 proves controlled authority.

## Write-Back Architecture

Use this pattern for assignment-style writes.

```text
Prime Radiant UI
  |
  v
Public endpoint
  |
  v
Trusted receiver
  |
  v
Validate request
  |
  v
Write intent audit receipt
  |
  v
Apply one allowlisted operation
  |
  v
Write accepted receipt + rollback object
  |
  v
Return receipt to dashboard
```

Recommended operations:

- `assign_agent_to_plan`
- `unassign_agent_from_plan`
- `replace_lane_assignment`
- `restore_lane_assignments`

Start with one-lane operations. Do not start with bulk reassignment. Bulk operations hide too much consequence in one button.

## Required Environment Flags

Use names that fit your deployment, but keep these controls.

```bash
PRIME_RADIANT_WRITEBACK_ENABLED=0
PRIME_RADIANT_WRITEBACK_MODE=dry_run
PRIME_RADIANT_LIVE_WRITES=0
PRIME_RADIANT_ALLOWED_OPERATIONS=assign_agent_to_plan,unassign_agent_from_plan,replace_lane_assignment
PRIME_RADIANT_AUDIT_DIR=/path/to/audit
PRIME_RADIANT_AGENT_ROSTER=/path/to/agents.json
PRIME_RADIANT_ASSIGNMENT_LEDGER=/path/to/assignments.json
```

Meaning:

- `WRITEBACK_ENABLED=0` means the endpoint refuses write-back requests.
- `MODE=dry_run` means requests return diffs and rollback objects without mutation.
- `LIVE_WRITES=0` means even write mode cannot mutate.
- `ALLOWED_OPERATIONS` keeps the receiver from becoming a generic write tunnel.
- `AUDIT_DIR` is required before live writes.
- `AGENT_ROSTER` defines agents, project tags, lane tags, and allowed operations.
- `ASSIGNMENT_LEDGER` must be validated before live writes.

## Request Contract

Use a fixed schema. Avoid flexible payloads.

```json
{
  "request_id": "req_123",
  "operation": "replace_lane_assignment",
  "mode": "dry_run",
  "actor": {
    "id": "operator",
    "type": "human"
  },
  "target": {
    "plan_id": "open-brain-relaunch",
    "splice_id": "stage-3-writeback"
  },
  "replace": {
    "from_agent_id": "builder",
    "to_agent_id": "reviewer",
    "role": "owner"
  },
  "reason": "Move this lane to review.",
  "idempotency_key": "stable_hash_of_request_without_server_timestamps"
}
```

Receiver requirements:

- Reject missing `request_id`.
- Reject unknown operation.
- Reject unknown plan, splice, or agent.
- Reject malformed ledger.
- Reject live write if audit directory is missing.
- Reject live write when live writes are disabled.
- Reject payloads that look like bulk reassignment.
- Hash only caller-controlled request fields for idempotency.
- Never include server-generated timestamps in the idempotency fingerprint.

## Proof Gates

Do not blend these gates.

| Gate | Meaning |
|---|---|
| Read-only board PASS | The board displays current plan/agent/gate state without mutation. |
| Interactive picture PASS | Drag/connect/reorder produces accurate preview state only. |
| Receiver dry-run PASS | Receiver returns diff and rollback object, ledger unchanged. |
| Deployed dry-run PASS | Production endpoint reaches receiver and returns dry-run proof. |
| Live write PASS | One stamped write mutates exactly one intended assignment. |
| Replay PASS | Same request returns idempotent success without a second mutation. |
| Rollback PASS | Stamped rollback restores the exact prior assignment state. |
| Public claim PASS | Repo/docs/article accurately describe only what is shipped. |

Each gate needs its own receipt. A green CI check is not a live-write stamp. A dry-run is not a write. A write is not a rollback.

## Templates And Prompts

Use these files:

- [templates/prime-radiant-lane.md](../templates/prime-radiant-lane.md)
- [templates/prime-radiant-writeback-report.md](../templates/prime-radiant-writeback-report.md)
- [templates/prime-radiant-board-readiness.md](../templates/prime-radiant-board-readiness.md)
- [prompts/prime-radiant-reviewer.md](../prompts/prime-radiant-reviewer.md)

## Setup Checklist

1. Define your agents.
2. Define your plans.
3. Define your splices.
4. Add a Chevron block or equivalent current-state marker to every active plan.
5. Create assignment edges.
6. Add closeout and gate-report templates.
7. Add the Memory Red-Team / Seldon Crisis Guard in observe-only mode.
8. Build the read-only board.
9. Add interactive draft moves.
10. Add receiver dry-run.
11. Add deployed dry-run.
12. Add one live write operation.
13. Prove replay.
14. Prove rollback.
15. Only then expand operations.

It is tempting to start at step 12. That temptation has a name: incident report.

## Search Terms

Prime Radiant, AI agent operating board, AI agent control plane, AI agent assignment board, multi-agent workflow board, MCP memory dashboard, Open Brain, Chevrons, Seldon Plans, agent handoff receipts, AI agent write-back, AI agent rollback, AI red-team memory guard, Seldon Crisis.
