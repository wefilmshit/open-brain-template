---
name: the-council
description: Use when Tony says "Council", "run it past the Council", "two professors", "independent research", "pressure-test with research", "see if existing tools are better", or asks for Claude+Codex with Grok/Perplexity research assistants.
---

# The Council

## Current Meaning

Council now means the **Research-Augmented Claude+Codex Loop**.

The old single-model / five-advisor Council pattern is retired. Do not run Contrarian, First Principles, Expansionist, Outsider, Executor, or Chairman as one model wearing costumes. That pattern is theater and was killed after the Apr 29 2026 test.

## Roles

- **Professor 1:** Claude.
- **Professor 2:** Codex.
- **Research assistants:** Grok for X/practitioner dissent, Perplexity/community-pulse for whitelisted forums, GitHub, HN, Reddit, Stack Overflow, arXiv, and similar sources.
- **EP / final judge:** Tony.

Claude and Codex are evaluators, not passive summarizers. They verify cited sources, weigh evidence quality, and each include `best_argument_against_my_own_position`.

Grok and Perplexity are research assistants, not decision-makers. Give them curated, scrubbed payloads only. Never send client-private, contact-private, financial, or unreleased creative material.

## First Actions

1. Recall the operative memories:
   - `701f575c-866b-408d-9c75-954c4323710a` — Research-Augmented Claude+Codex Loop.
   - `64d785bd-d6cc-4cf0-885b-19146d071941` — why single-model Council is theater and cross-model blind spots matter.
2. Use the executable runner at `WFS-bolt/scripts/ai-chatboard/research_augmented_loop_runner.py`.
3. If that runner is missing or broken, halt and restore/fix the runner. Do not substitute a manual prompt packet.
4. If the question needs external reality, the runner calls Grok and Perplexity/community-pulse with scrubbed Tier 2 payloads.
5. Produce one synthesized verdict for Tony. Do not show raw advisor noise unless Tony asks.

## When To Use

Use Council for consequential judgment under ambiguity, especially:

- Build versus buy.
- "Did we invent something new or is there a better existing tool?"
- Architecture choices with real external alternatives.
- High-confidence agreement between agents where practitioner evidence might reveal a blind spot.
- Vendor/tool selection.
- Product strategy, sequencing, or whether to kill/change/keep a pattern.

Do not use Council for routine coding tasks, local repo facts, or questions answered by reading code/artifacts/memory.

## Required Shape

Use this compact structure:

```text
Question
What Tony is asking us to decide.

Internal Thesis
What Claude/Codex currently believe from WFS context and repo evidence.

Research Pull
What Grok/Perplexity/web research should verify, including exact search scope and excluded sources.

Professor A Read
Independent position with evidence and best_argument_against_my_own_position.

Professor B Read
Independent position with evidence and best_argument_against_my_own_position.

Blind-Spot Audit
What Grok/auditor says the professors may be missing.

Verdict For Tony
One clear recommendation, what would change it, and next action.
```

When only one professor is present in the current tool session, run the executable runner so local Claude and local Codex act as separate professor subprocesses. Do not prepare a manual handoff packet as the normal path. A packet is only acceptable as a diagnostic artifact after explicitly reporting that the runner is unavailable.

## Research Rules

Prefer practitioner evidence over vendor marketing:

- Good: GitHub issues/discussions, Reddit practitioner threads, HN, Stack Overflow, arXiv/research, official API docs for factual API behavior.
- Weak: vendor blogs, launch posts, affiliate lists, generic "top 10 tools" pages, AI influencer threads.

Use sources as evidence, not authority. Verify citations when possible.

## Hard Bans

- Do not resurrect the five-advisor Council.
- Do not let one model write all sides and call it disagreement.
- Do not route private/client material through Grok or Perplexity.
- Do not auto-write architecture-state memory from a Council verdict without Tony approval, unless Tony explicitly asks to update memory.
- Do not let research assistants decide. Professors decide; Tony judges.

## Paper Trail

- Operative architecture memory: `701f575c-866b-408d-9c75-954c4323710a`.
- Blind-spot principle memory: `64d785bd-d6cc-4cf0-885b-19146d071941`.
- Retired five-advisor test artifact: `WFS-bolt/artifacts/ai-chatboard/the-council-test1-multi-model-20260429-1331.md`.
