---
description: Create or update the feature specification from a natural language feature description.
handoffs:
  - label: Build Technical Plan
    agent: speckit.plan
    prompt: Create a plan for the spec. I am building with...
  - label: Clarify Spec Requirements
    agent: speckit.clarify
    prompt: Clarify specification requirements
    send: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution

Check `.specify/extensions.yml` for `hooks.before_specify` entries:
- For each executable hook, output the following based on its `optional` flag: prompt optional hooks, auto-execute mandatory hooks.
- Skip if no hooks registered or file absent.

## Output constraint

**spec.md must be ≤50 lines.** Terse, testable, no prose.

## Steps

1. **Short name** (2-4 words, kebab-case) from the feature description. Action-noun format (`add-user-auth`, `fix-payment-timeout`). Preserve acronyms (OAuth2, JWT).

2. **Branch creation** (optional): if a `before_specify` hook ran, it emits `BRANCH_NAME` + `FEATURE_NUM` JSON. Note but don't block on it. If user provided `GIT_BRANCH_NAME`, pass through.

3. **Spec directory**: resolve `SPECIFY_FEATURE_DIRECTORY`:
   - If user provided one, use it.
   - Else check `.specify/init-options.json` for `branch_numbering`:
     - `"timestamp"`: prefix = `YYYYMMDD-HHMMSS`
     - `"sequential"` or absent: prefix = `NNN` (next 3-digit after scanning `specs/`)
   - Directory = `specs/<prefix>-<short-name>`

4. **Create**: `mkdir -p SPECIFY_FEATURE_DIRECTORY`, copy `templates/spec-template.md` → `SPECIFY_FEATURE_DIRECTORY/spec.md`, set `SPEC_FILE`. Persist `{ "feature_directory": "<resolved path>" }` to `.specify/feature.json`.

5. **Fill spec.md** from the feature description:
   - 2-4 user stories (P1, P2, P3) — one sentence each + Given/When/Then
   - 3-5 functional requirements — testable, no tech details
   - 3-4 success criteria — measurable, tech-agnostic
   - Max 3 `[NEEDS CLARIFICATION: ...]` markers (scope > security > UX > tech)
   - Reasonable defaults for unspecified details (note in Assumptions)

6. **Validate**: ≤50 lines, no implementation details, testable requirements.

7. **Quality checklist** at `SPECIFY_FEATURE_DIRECTORY/checklists/requirements.md`: content-quality, requirement-completeness, feature-readiness (see checklist template). Fail items → edit spec, re-validate (max 3 iterations).

8. **Open questions**: if `[NEEDS CLARIFICATION]` markers remain (max 3), present each as a markdown table with 3 suggested answers + "Custom" option. Wait for user response. Replace markers with answers. Re-validate.

9. **Report**: `SPECIFY_FEATURE_DIRECTORY`, `SPEC_FILE`, checklist summary, next phase (`__SPECKIT_COMMAND_CLARIFY__` or `__SPECKIT_COMMAND_PLAN__`).

10. Run `hooks.after_specify` if present.

## Rules

- **WHAT and WHY**, not HOW (no tech stack, APIs, code).
- For business stakeholders, not developers.
- Success criteria are measurable + tech-agnostic:
  - ✅ "Users complete checkout in under 3 minutes"
  - ❌ "API response time under 200ms"
- Remove sections that don't apply; don't leave "N/A".

## Examples

```bash
/speckit-specify Build an application that organizes photos into albums by date
```
