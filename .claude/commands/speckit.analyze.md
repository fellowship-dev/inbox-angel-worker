---
description: Perform a non-destructive cross-artifact consistency and quality analysis across spec.md, plan.md, and tasks.md after task generation.
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

Run `hooks.before_analyze` from `.specify/extensions.yml` if present.

## Constraints

**READ-ONLY.** Do not modify any files. Output a single analysis report.

**Constitution is authoritative.** Conflicts with `/memory/constitution.md` → always CRITICAL. Principles change only via `__SPECKIT_COMMAND_CONSTITUTION__`.

## Steps

1. **Setup**: run `{SCRIPT}`. Parse `FEATURE_DIR` + `AVAILABLE_DOCS`. Derive absolute paths:
   - `SPEC = FEATURE_DIR/spec.md`
   - `PLAN = FEATURE_DIR/plan.md`
   - `TASKS = FEATURE_DIR/tasks.md`

   Abort if any is missing.

2. **Load minimally**:
   - `spec.md` → Overview, Functional Requirements, Success Criteria, User Stories, Edge Cases
   - `plan.md` → Architecture, data-model refs, phases, constraints
   - `tasks.md` → IDs, descriptions, phases, `[P]`, file paths
   - `constitution.md` → principles

3. **Build internal models** (don't emit):
   - Requirements inventory: FR-###, SC-### as keys (skip non-buildable outcomes like "reduce tickets by 50%")
   - User-action inventory with acceptance criteria
   - Task → requirement mapping
   - Constitution MUST/SHOULD statements

4. **Detection passes** (max 50 findings; overflow summarized):
   - **A. Duplication** — near-duplicate requirements; flag worse phrasing
   - **B. Ambiguity** — vague adjectives ("fast", "robust") without metrics; TODO/TKTK/`<placeholder>`
   - **C. Underspecification** — verbs with no object; stories missing acceptance; tasks referencing undefined components
   - **D. Constitution alignment** — any conflict with MUST principle; missing mandated sections
   - **E. Coverage gaps** — requirements with 0 tasks; tasks with no mapped requirement; buildable SCs not reflected in tasks
   - **F. Inconsistency** — terminology drift; entity mentioned in plan but not spec (or vice versa); task ordering contradictions; conflicting choices (Next.js vs Vue)

5. **Severity**:
   - CRITICAL — constitution MUST violation, missing core artifact, zero-coverage blocking baseline
   - HIGH — duplicate/conflicting requirement, ambiguous security/perf attribute, untestable acceptance
   - MEDIUM — terminology drift, missing NFR coverage, underspecified edge case
   - LOW — wording, minor redundancy

6. **Emit report**:

   ```
   ## Specification Analysis Report

   | ID | Category | Severity | Location | Summary | Recommendation |

   ## Coverage Summary

   | Requirement | Has Task? | Task IDs | Notes |

   ## Constitution Alignment Issues
   ## Unmapped Tasks
   ## Metrics
   - Total requirements / tasks / coverage % / ambiguity / duplication / critical count
   ```

   Stable IDs prefixed by category initial (`D1`, `A2`, …).

7. **Next actions**:
   - CRITICAL present → recommend resolving before `__SPECKIT_COMMAND_IMPLEMENT__`
   - Only LOW/MEDIUM → may proceed; list improvement suggestions
   - Suggest specific follow-up commands

8. **Offer remediation**: ask "Suggest concrete edits for top N?" — never apply automatically.

9. Run `hooks.after_analyze` if present.

## Principles

- **Never modify files.**
- **Never hallucinate missing sections** — report them as absent.
- **Constitution violations are always CRITICAL.**
- Cite specific instances, not generic patterns.
- Deterministic: same input → same IDs and counts.
