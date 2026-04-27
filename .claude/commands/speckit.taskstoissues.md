---
description: Convert existing tasks into actionable, dependency-ordered GitHub issues for the feature based on available design artifacts.
tools: ['github/github-mcp-server/issue_write']
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

Run `hooks.before_taskstoissues` from `.specify/extensions.yml` if present.

## Steps

1. **Setup**: run `{SCRIPT}`. Parse `FEATURE_DIR` and `AVAILABLE_DOCS`. Escape quotes in args: `'I'\''m Groot'`.

2. **Locate tasks**: extract the path to `tasks.md` from the script output.

3. **Verify remote is GitHub**:

   ```bash
   git config --get remote.origin.url
   ```

   > [!CAUTION]
   > ONLY PROCEED IF THE REMOTE IS A GITHUB URL.

4. **Create issues**: for each task in `tasks.md`, use the GitHub MCP server to create an issue in the repo matching the git remote.

   > [!CAUTION]
   > NEVER CREATE ISSUES IN REPOSITORIES THAT DO NOT MATCH THE REMOTE URL.

5. Run `hooks.after_taskstoissues` if present.
