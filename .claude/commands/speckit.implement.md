---
description: Execute the implementation plan by processing and executing all tasks defined in tasks.md
scripts:
  sh: scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks
  ps: scripts/powershell/check-prerequisites.ps1 -Json -RequireTasks -IncludeTasks
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution

Run `hooks.before_implement` from `.specify/extensions.yml` if present.

## Steps

1. **Setup**: run `{SCRIPT}`. Parse `FEATURE_DIR` and `AVAILABLE_DOCS`. Escape quotes in args: `'I'\''m Groot'`.

2. **Checklist gate** (if `FEATURE_DIR/checklists/` exists):
   - Count `- [ ]` (incomplete) vs `- [X]|- [x]` (done) per checklist.
   - Emit a status table (`| Checklist | Total | Completed | Incomplete | Status |`).
   - **If any incomplete** → stop and ask: `"Some checklists are incomplete. Proceed anyway? (yes/no)"`. Halt on `no`/`stop`.
   - **If all pass** → proceed.

3. **Load context**:
   - Required: `tasks.md`, `plan.md`
   - Optional: `data-model.md`, `contracts/`, `research.md`, `quickstart.md`

4. **Verify ignore files** — create/append as needed based on detected tooling:
   - git repo → `.gitignore`
   - `Dockerfile*` or Docker in plan → `.dockerignore`
   - `.eslintrc*` → `.eslintignore`; `.prettierrc*` → `.prettierignore`
   - Language/tool patterns as appropriate (node_modules, __pycache__, target/, bin/, etc.)
   - Always include `.DS_Store`, `*.log`, `.env*`

5. **Parse tasks.md**: extract phases, dependencies, task details (ID, file paths, `[P]` markers), execution order.

6. **Execute**:
   - Phase-by-phase; finish phase N before N+1.
   - Sequential tasks in order. `[P]` tasks may run in parallel.
   - Tests before their corresponding implementation if TDD was requested.
   - Tasks hitting the same file are serial regardless of `[P]`.

7. **Progress**:
   - Mark each completed task `- [X]` in `tasks.md`.
   - Report after each task.
   - Halt if a non-parallel task fails. For `[P]` failures, continue with survivors + list failures.

8. **Completion**:
   - Verify all tasks done.
   - Check implementation matches spec.
   - Confirm tests pass.
   - Final status report with summary of work.

9. Run `hooks.after_implement` if present.

## Rules

- If `tasks.md` is missing or incomplete, suggest `__SPECKIT_COMMAND_TASKS__` first.
- Use absolute paths for file ops, project-relative for references.
