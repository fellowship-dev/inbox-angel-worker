# Quality Score — inbox-angel-worker

## Domains

| Domain | Grade | Last audit | Notes |
|--------|-------|------------|-------|
| dashboard | D | 2026-04-17 | S2 ✅ FlowChad flows added (PR #65 — domain-source-ip.yml, score-circle.yml); S1 ❌ no code-structure.md; S3 ❌ staleness ∞ (docs absent); S4 ✅ 2 open issues; S5 neutral (470 tests pass, no coverage report); S6 ❌ no doc-coverage.json |
| api | F | 2026-04-17 | No code-structure.md; no FlowChad flow for API layer; no doc-coverage.json; staleness ∞ (docs absent); 2 open issues ✅; tests exist (router.test.ts) but zero prose docs |
| db | F | 2026-04-17 | No code-structure.md; no FlowChad flow; no doc-coverage.json; staleness ∞ (docs absent); 0 open issues ✅; migration layer entirely undocumented |
| core | F | 2026-04-17 | No code-structure.md; no FlowChad flow; no doc-coverage.json; staleness ∞ (docs absent); 0 open issues ✅; env-utils.ts and config.ts have zero prose docs |
| ci | F | 2026-04-17 | No code-structure.md; no FlowChad flow; staleness ∞ (docs absent); 1 open issue ✅; test coverage N/A; no doc-coverage.json |
| qa | F | 2026-04-17 | NEW domain (.flowchad/ scaffold added in PR #65); S1 ❌ no code-structure.md; S2 N/A (meta-layer); S3 ❌ staleness ∞ (no prose docs for QA layer); S4 ✅ 1 open issue; S5 neutral; S6 ❌ no doc-coverage.json |

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
| 2026-04-17 | PR #63 (ci: add Cloudflare Worker deploy workflow) | 1 domain scanned (ci — new) — grade F; 0 regressions, 0 improvements; speckit drift: none |
| 2026-04-17 | PR #65 (chore: add FlowChad QA scaffold) | 6 domains scanned (full sweep — structural change), 0 regressions, 0 grade changes; dashboard Signal 2 flipped ✅ (FlowChad flows added); 1 new domain added (qa: F) |

## Tooling

**Speckit**: installed locally in `.specify/` and gitignored per inbox-angel-worker convention. Not tracked in version control. Lib drift cannot be assessed remotely — flag for dev to verify speckit version parity with `npx skills` registry.

**Hookshot**: No `doc-coverage.json` found. Hookshot has not been run on this repo. Pre-edit reminder hooks are absent — agents receive no doc-pointer prompts before editing core modules.

**FlowChad**: `.flowchad/` scaffold added in PR #65. Two flows active: `domain-source-ip.yml` and `score-circle.yml` (both cover dashboard UX). No flows yet for api, db, core, ci domains.

**docs/code-structure.md**: Does not exist. This is the primary doc coverage artifact and its absence causes all domains to fail Signal 1. Creating this file would immediately improve grades across all 6 domains.
