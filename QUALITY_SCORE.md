# Quality Score — inbox-angel-worker

## Domains

| Domain | Grade | Last audit | Notes |
|--------|-------|------------|-------|
| dashboard | D | 2026-04-17 | No code-structure.md; no FlowChad dir (prev. audit false positive — e2e Playwright specs ≠ FlowChad flows); no doc-coverage.json; staleness ∞ (docs absent); 2 open issues ✅; 470 tests pass but no coverage report |
| api | F | 2026-04-16 | No code-structure.md; no FlowChad flow for API layer; no doc-coverage.json; staleness delta 40d; tests exist (router.test.ts) but zero prose docs |
| db | F | 2026-04-16 | No code-structure.md; no FlowChad flow; no doc-coverage.json; staleness delta 40d; migration layer entirely undocumented |
| core | F | 2026-04-16 | env-utils.ts has no documentation coverage in any layer; no code-structure.md, no FlowChad, no doc-coverage.json |

## Signal Reference

| Signal | Description | Threshold |
|--------|-------------|-----------|
| Doc Coverage | Domain mentioned in docs/code-structure.md | ✅/❌ |
| FlowChad Coverage | Entry in .flowchad/flows/ | ✅/❌ |
| Staleness Delta | Days since last doc update vs last code commit | ✅ ≤30d / ⚠️ 31-60d / ❌ >60d |
| Open Issues | Issues mentioning domain | ✅ 0-3 / ⚠️ 4-6 / ❌ >6 |
| Test Coverage | Coverage report if available | neutral if unavailable |
| Hookshot Staleness | doc-coverage.json vs docs/code-structure.md age | ✅/⚠️/❌ |

## History

| Date | Trigger | Summary |
|------|---------|---------|
| 2026-04-16 | PR #60 (feat: subdomain support) | 4 domains scanned, 3 F grades, 1 D grade, 0 improvements — docs/code-structure.md absent repo-wide |
| 2026-04-17 | PR #61 (feat: dashboard UX quick wins) | 1 domain scanned (dashboard) — grade D→D, no regression; FlowChad false positive from prev. audit corrected; staleness remains ∞ (docs/code-structure.md still absent) |

## Tooling

**Speckit**: installed locally in `.specify/` and gitignored per inbox-angel-worker convention. Not tracked in version control. Lib drift cannot be assessed remotely — flag for dev to verify speckit version parity with `npx skills` registry.

**Hookshot**: No `doc-coverage.json` found. Hookshot has not been run on this repo. Pre-edit reminder hooks are absent — agents receive no doc-pointer prompts before editing core modules.

**docs/code-structure.md**: Does not exist. This is the primary doc coverage artifact and its absence causes all domains to fail Signal 1. Creating this file would immediately improve grades across all 4 domains.
