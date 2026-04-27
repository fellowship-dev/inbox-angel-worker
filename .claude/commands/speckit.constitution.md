---
description: Create or update the project constitution from interactive or provided principle inputs, ensuring all dependent templates stay in sync.
handoffs:
  - label: Build Specification
    agent: speckit.specify
    prompt: Implement the feature specification based on the updated constitution. I want to build...
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution

Run `hooks.before_constitution` from `.specify/extensions.yml` if present.

## Target

Fill or amend `.specify/memory/constitution.md` from `[ALL_CAPS_TOKEN]` placeholders. If missing, copy `.specify/templates/constitution-template.md` first.

## Steps

1. **Load** existing constitution. Identify every `[ALL_CAPS]` placeholder. User may specify fewer/more principles than the template — respect that.

2. **Collect values**:
   - Prefer user input.
   - Else infer from repo (README, docs, prior versions).
   - `RATIFICATION_DATE` = original adoption date (ask or mark `TODO` if unknown).
   - `LAST_AMENDED_DATE` = today iff changes made.
   - `CONSTITUTION_VERSION` semver bump:
     - MAJOR — backward-incompatible removal/redefinition
     - MINOR — new principle/section or materially expanded guidance
     - PATCH — wording, typos, non-semantic refinements
   - Ambiguous bump → propose rationale first.

3. **Draft**:
   - Replace every placeholder with concrete text. Intentional unresolved placeholders must be justified.
   - Each Principle: succinct name, paragraph or bullets of non-negotiable rules, rationale if non-obvious.
   - Governance section: amendment procedure, versioning policy, compliance review.

4. **Propagate**:
   - `.specify/templates/plan-template.md` — align "Constitution Check" with updated principles.
   - `.specify/templates/spec-template.md` — align mandatory sections/constraints.
   - `.specify/templates/tasks-template.md` — align task categorization.
   - `.specify/templates/commands/*.md` — remove outdated agent-specific references.
   - `README.md` / runtime docs — update principle references.

5. **Sync Impact Report** as HTML comment at top of constitution:
   - Version change: old → new
   - Modified principles (renames noted)
   - Added / removed sections
   - Templates updated (✅) or pending (⚠) with paths
   - Deferred TODOs

6. **Validate before write**:
   - No unexplained bracket tokens.
   - Version line matches report.
   - Dates in ISO format `YYYY-MM-DD`.
   - Principles declarative + testable (`MUST`/`SHOULD` instead of `should`).

7. **Write** back to `.specify/memory/constitution.md` (overwrite).

8. **Report**: new version + bump rationale, files flagged for follow-up, suggested commit message (e.g., `docs: amend constitution to vX.Y.Z`).

9. Run `hooks.after_constitution` if present.

## Rules

- Preserve heading hierarchy exactly.
- Single blank line between sections. No trailing whitespace.
- Missing critical info → `TODO(<FIELD>): explanation` + list under deferred items.
- Never create a new file — always amend `.specify/memory/constitution.md`.
