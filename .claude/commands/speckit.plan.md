---
description: Execute the implementation planning workflow using the plan template to generate design artifacts.
handoffs:
  - label: Create Tasks
    agent: speckit.tasks
    prompt: Break the plan into tasks
    send: true
  - label: Create Checklist
    agent: speckit.checklist
    prompt: Create a checklist for the following domain...
scripts:
  sh: scripts/bash/setup-plan.sh --json
  ps: scripts/powershell/setup-plan.ps1 -Json
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution

Run `hooks.before_plan` from `.specify/extensions.yml` if present.

## Output constraint

**plan.md must be ≤60 lines.** Tables and bullets over prose.

## Steps

1. **Setup**: Run `{SCRIPT}`. Parse JSON for `FEATURE_SPEC`, `IMPL_PLAN`, `SPECS_DIR`, `BRANCH`. Escape single quotes in args: `'I'\''m Groot'`.

2. **Load context**: read `FEATURE_SPEC` and `/memory/constitution.md`. Load `IMPL_PLAN` template (already copied).

3. **Phase 0 — Research**: for each `[NEEDS CLARIFICATION]` in Technical Context, for each dependency, for each integration: generate a research task. Consolidate in `research.md`:
   - Decision: what was chosen
   - Rationale: why
   - Alternatives: what else was considered

4. **Phase 1 — Design**:
   - Extract entities from spec → `data-model.md` (fields, relationships, state transitions)
   - Define interface contracts (if external interfaces exist) → `contracts/` (API, CLI schema, UI contracts — pick format for project type)
   - Write `quickstart.md` with happy-path smoke-test steps
   - Update the `<!-- SPECKIT START -->` block in `__CONTEXT_FILE__` to point to the IMPL_PLAN

5. **Constitution gates**: evaluate before + after design. ERROR on unjustified violations or unresolved clarifications.

6. **Stop and report**: branch, `IMPL_PLAN` path, artifacts (research.md, data-model.md, contracts/, quickstart.md). Do NOT generate tasks here.

7. Run `hooks.after_plan` if present.

## Rules

- Absolute paths for filesystem ops; project-relative for doc references.
- ERROR on gate failures or unresolved `[NEEDS CLARIFICATION]`.
- Skip `contracts/` for internal-only projects (build scripts, one-off tools).
