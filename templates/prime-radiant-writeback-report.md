# Prime Radiant Write-Back Report Template

## Decision

PASS / HOLD / FAIL / PASS WITH WARNING

## Operation

- Operation:
- Mode: dry_run / write
- Request ID:
- Idempotency key:
- Actor:
- Target plan:
- Target splice:

## Pre-State

- Assignment ledger hash:
- Current assignment:
- Audit directory present:
- Live writes flag:

## Result

- HTTP status:
- Receiver result:
- Mutation count:
- Assignment after:
- Ledger hash after:

## Receipts

- Intent receipt:
- Accepted receipt:
- Replay receipt:
- Rollback object:

## Replay Proof

State whether replay returned idempotent success and whether it caused zero additional mutation.

## Rollback Proof

State whether rollback was tested, not tested, or separately stamped.

## Safety

- Off-switch:
- Dry-run default:
- Bulk-shaped payload rejection:
- Browser-to-database path:
- Browser-to-plan-file path:
- Secrets printed:

## Verdict

State exactly what is accepted and what remains unstamped.
