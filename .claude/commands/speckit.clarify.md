---
description: Identify underspecified areas in the current feature spec by asking up to 5 highly targeted clarification questions and encoding answers back into the spec.
handoffs:
  - label: Build Technical Plan
    agent: speckit.plan
    prompt: Create a plan for the spec. I am building with...
scripts:
  sh: scripts/bash/check-prerequisites.sh --json --paths-only
  ps: scripts/powershell/check-prerequisites.ps1 -Json -PathsOnly
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution

Run `hooks.before_clarify` from `.specify/extensions.yml` if present.

## Goal

Reduce ambiguity in the active spec by asking ≤5 targeted questions and encoding answers back into `FEATURE_SPEC`. Run BEFORE `__SPECKIT_COMMAND_PLAN__`. If user skips, warn that rework risk rises.

## Steps

1. **Setup**: run `{SCRIPT}` (`--json --paths-only`). Parse `FEATURE_DIR`, `FEATURE_SPEC`. Escape quotes in args: `'I'\''m Groot'`. Abort if missing → instruct user to run `__SPECKIT_COMMAND_SPECIFY__`.

2. **Coverage scan** — mark each category Clear / Partial / Missing:
   - Functional scope (goals, out-of-scope, roles)
   - Domain & data model (entities, identity rules, lifecycle, volume)
   - Interaction & UX flow (journeys, error/empty/loading states, a11y)
   - Non-functional (perf, scale, reliability, observability, security, compliance)
   - Integration & deps (external APIs, failure modes, data formats)
   - Edge cases (negative scenarios, rate limits, conflict resolution)
   - Constraints & tradeoffs (tech constraints, rejected alternatives)
   - Terminology (glossary, avoided synonyms)
   - Completion signals (acceptance testability)
   - Placeholders (TODOs, vague adjectives lacking quantification)

3. **Build question queue (max 5 internal)**. Each question must:
   - Be answerable via multiple-choice (2–5 options) OR short answer (≤5 words)
   - Materially impact architecture / data / tasks / tests / UX / ops / compliance
   - Not already be answered, not be stylistic, not be plan-level detail

   Prioritize Impact × Uncertainty; keep category balance.

4. **Ask sequentially** — ONE question at a time:
   - For multiple-choice:
     - Determine best option (best practices, risk, alignment).
     - Present `**Recommended:** Option X — <1-sentence reasoning>` first.
     - Then a 2–5 row markdown table (`| Option | Description |`), plus a "Short" free-form row if a custom answer is useful.
     - Append: `Reply with a letter, say "yes"/"recommended", or provide a short answer.`
   - For short-answer:
     - Present `**Suggested:** <answer> — <brief reasoning>`.
     - Then: `Format: ≤5 words. Say "yes"/"suggested" to accept, or type your own.`
   - On `"yes"`/`"recommended"`/`"suggested"` → use your suggestion.
   - Else validate maps to an option / ≤5 words. If ambiguous, ask to disambiguate (same question counter).
   - Never reveal future questions.
   - Stop when: all critical ambiguities resolved, user says "done"/"good"/"stop", or 5 asked.

5. **Integrate each accepted answer immediately**:
   - Ensure `## Clarifications` exists (after the overview section); under it, `### Session YYYY-MM-DD`.
   - Append bullet: `- Q: <question> → A: <answer>`.
   - Apply to the relevant section:
     - Functional → Functional Requirements
     - Actors/UX → User Stories
     - Data shape → Data Model (add fields/constraints; preserve order)
     - Non-functional → Success Criteria (convert vague adjective to metric)
     - Edge case → Edge Cases / Error Handling
     - Terminology → normalize across the spec (keep old term only if necessary: `(formerly "X")` once)
   - Replace (don't duplicate) any invalidated earlier statement.
   - **Save spec after each integration** (atomic overwrite).

6. **Validate after each write + final pass**:
   - One bullet per accepted answer; no duplicates.
   - ≤5 asked.
   - No lingering vague phrases the answer resolved.
   - No now-invalid alternative still present.
   - Only new headings: `## Clarifications`, `### Session YYYY-MM-DD`.

7. **Report**: count asked/answered, spec path, sections touched, coverage table (Resolved / Deferred / Clear / Outstanding), recommended next command.

8. Run `hooks.after_clarify` if present.

## Rules

- If nothing material is ambiguous → `"No critical ambiguities detected worth formal clarification."` and suggest proceeding.
- If spec is missing → instruct `__SPECKIT_COMMAND_SPECIFY__` first. Don't create a new spec here.
- Never exceed 5 questions (retries on a single question don't count as new).
- Respect early termination: "stop"/"done"/"proceed".
