---
description: Generate an actionable, dependency-ordered tasks.md for the feature based on available design artifacts.
handoffs:
  - label: Analyze For Consistency
    agent: speckit.analyze
    prompt: Run a project analysis for consistency
    send: true
  - label: Implement Project
    agent: speckit.implement
    prompt: Start the implementation in phases
    send: true
scripts:
  sh: scripts/bash/check-prerequisites.sh --json
  ps: scripts/powershell/check-prerequisites.ps1 -Json
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution

Run `hooks.before_tasks` from `.specify/extensions.yml` if present.

## Output constraint

**Tasks MUST use the checklist format** (see below). No prose. Absolute file paths per task.

## Steps

1. **Setup**: run `{SCRIPT}`. Parse `FEATURE_DIR` and `AVAILABLE_DOCS`. Escape quotes in args: `'I'\''m Groot'`.

2. **Load docs** from `FEATURE_DIR`:
   - Required: `plan.md` (stack, structure), `spec.md` (user stories with priorities)
   - Optional: `data-model.md`, `contracts/`, `research.md`, `quickstart.md`
   - Not all projects have all docs — generate from what's available.

3. **Extract**:
   - Tech stack, libraries, structure from `plan.md`
   - User stories with P1/P2/P3 priority from `spec.md`
   - Entities from `data-model.md` → map to stories
   - Interface contracts → map to stories
   - Decisions from `research.md` → setup tasks

4. **Generate `tasks.md`** from `templates/tasks-template.md`:
   - Phase 1: Setup (project init)
   - Phase 2: Foundational (blocks all stories)
   - Phase 3+: one phase per user story, in priority order
   - Final: Polish & cross-cutting
   - Dependencies section + parallel execution examples per story
   - Implementation strategy: MVP first

5. **Report**: total count, count per story, parallel opportunities, MVP scope (usually US1), format validation (every task has checkbox + ID + labels + file path).

6. Run `hooks.after_tasks` if present.

## Checklist format (REQUIRED)

```text
- [ ] [TaskID] [P?] [Story?] Description with file path
```

- `- [ ]` — markdown checkbox, always
- `T001, T002, …` — sequential task ID
- `[P]` — include ONLY if parallelizable (different files, no blocking deps)
- `[US1|US2|…]` — REQUIRED for story-phase tasks; OMIT for setup/foundational/polish
- Description — action + exact file path

Examples:
- ✅ `- [ ] T001 Create project structure per plan`
- ✅ `- [ ] T005 [P] Implement auth middleware in src/middleware/auth.py`
- ✅ `- [ ] T012 [P] [US1] Create User model in src/models/user.py`
- ❌ `T001 [US1] Create model` (no checkbox)
- ❌ `- [ ] T001 [US1] Create model` (no file path)

## Rules

- Tests are OPTIONAL — only generate test tasks if TDD is explicitly requested.
- Each user story phase is independently testable (an MVP slice on its own).
- Tasks hitting the same file are sequential, not `[P]`.
