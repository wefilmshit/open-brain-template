---
name: wfs-context-refresh
description: Use when working on WFS, IPE, ICE architecture, Intelligent Production, the AI Chatboard, ICE search pipeline, master-score, spot_brain, ai_analysis, moderator drift checks, decision-card discipline, sandbox vs production boundaries, posting to or reading from the chatboard, drafting agent prompts, designing or reviewing agent profiles, or making WFS architectural recommendations.
---

# WFS Context Refresh

## First Action: Load Live State

Before making non-trivial WFS recommendations, call:

```text
mcp__personal-memory__recall(
  query="current wfs architecture state",
  category="project",
  limit=5
)
```

Treat returned memories tagged `wfs-architecture-state` as live state. Live state is more current than this file on phase status, in-flight work, recent decisions, and shipped/deployed state. If no useful memories return, continue from the static facts below and note the retrieval gap if it matters.

## Static Architecture Facts

WFS context refresh, current as of 2026-04-29:

ARCHITECTURE FACTS:
- AI Chatboard is a decision-provenance bus and shared working memory, not a product chatroom. Agents post structured decision cards; Tony approves consequential choices.
- Sandbox Supabase project: bzvludcxjevdxvcxpceo. Production: inqwtstopucpxfnuisus. Wakeup daemon writes only to sandbox.
- Board modes matter: design_lab and sandbox_debug are not production. Do not propose production writes, deploys, or migrations from design_lab. Refuse the request explicitly if asked.

ICE SEARCH FACTS:
- ICE search already has a persisted spot_brain layer. Do not claim spot_brain is missing unless live code/data proves it.
- Current spot_brain fields are exactly: problem_solved, audience_feels, skills_proven, perfect_for.
- Adjacent spot metadata also exists in ai_analysis, including tone/performance/creative-device fields for most analyzed spots. Do not conflate ai_analysis with spot_brain; they are adjacent layers.
- Search-time agents should NOT rewatch/reprocess all videos. Query-time search reads existing spot_brain + ai_analysis + embeddings + Twelve Labs metadata/summaries, then validates final proof clips only when needed.
- Current strategic question for Stage 3 is how to parallelize reads/ranking over the existing spot-brain layer and shared memory, not how to create agents that reprocess video.
- Verified pilot manifest at artifacts/ai-chatboard/ice-search-improvement-plan-verification-20260429-0334.md. Cite manifest directors when discussing director-side recommendations.

DECISION-CARD DISCIPLINE:
- Confidence MUST stay below 0.85 unless escalating to Tony. Also stay within +0.20 of the prior agent's confidence on this thread. The deterministic moderator at supabase/functions/_shared/aiChatboardModerator.ts checks: fast_confidence_rise (delta > 0.20 in one turn), high_confidence_no_disagreement (>=0.85 with empty/short disagreement), same_direction_streak, fast_consensus, circular_citation, dominance, weak_evidence, thread_vendor_cost_exceeded, information_withholding, topic_drift. Cards that trip these are flagged or rejected.
- Set human_approval_needed=true ONLY for: canonical-write tools (accept_answer, emit_learning_signal, write_master_brain_entry), payload_class > internal, target_environment=production, financial_impact, mode escalation, or low confidence (<0.65) on high-stakes recommendations. Default false.
- Cite real evidence: internal_artifact (file:line range), external_source (URL), agent_post (MUST include trace_id), or human_note. If all your evidence is agent_post, the moderator will inject a root evidence ref automatically.

OPERATIONAL CONTEXT:
- The wakeup daemon gives you this refresh plus the current thread. You do not automatically have full WFS memory unless it appears in the prompt, thread, repo files, or cited artifacts.
- Successful posts trigger an iMessage digest to Tony. Each post is operator noise; do not post unnecessarily.
- If a premise conflicts with this refresh, say so directly and cite the conflict in disagreement/uncertainty instead of accepting the premise.

## Merge Pattern

Use static facts as the architectural baseline: project IDs, spot_brain field list, production boundaries, moderator checks, and decision-card discipline.

Use recalled live state as session context: what is locked, what is in-flight, what was just shipped, what thread is waiting on which agent, and which decision artifacts supersede older plans.

If static facts and live state conflict:
- Prefer recalled live state for phase status, deployment status, recent decisions, and active thread state.
- Prefer this skill's static facts for stable architectural facts unless live code/data proves the static fact is outdated.
- If the conflict affects a consequential recommendation, state the conflict explicitly and ask for Tony review or cite the newer evidence.

## Write-Back Convention

When you make or verify a major WFS architectural decision, write one concise Open Brain memory:

```text
mcp__personal-memory__remember(
  category="project",
  tags=["wfs-architecture-state", "<specific-system>", "<phase-or-date>"],
  summary="<one sentence>",
  content="<decision, evidence/artifact path, status, and what it supersedes>"
)
```

Write a memory when:
- A phase is locked, shipped, paused, or superseded.
- An edge function is deployed or rolled back.
- Moderator checks, master-score weights, schema contracts, agent profiles, or skills change.
- A PR or artifact changes how agents should reason about WFS.
- You discover loaded context is stale and correct it with evidence.

Do not write full transcripts, drafts, or temporary notes to this memory convention. Use chatboard thread memory for working state.

## Wakeup Daemon Refactor Note

Follow-up TODO: `scripts/ai-chatboard/assigned-thread-wakeup.ts` currently hardcodes `WFS_CONTEXT_REFRESH`. Refactor it to source this skill file as the single stable context source, then append live state recalled from Open Brain before each model call.

