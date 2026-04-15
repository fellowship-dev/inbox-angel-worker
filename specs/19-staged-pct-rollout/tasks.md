# Tasks: Staged pct= Rollout (#19)

## Phase 1: Setup

- [x] T001 Add `rollout_rec_policy` + `rollout_rec_pct` columns to domains `migrations/0005_rollout_stage.sql`
- [x] T002 Extend `Domain` TypeScript interface with new columns `src/db/types.ts`
- [x] T003 Add `updateDomainRollout(db, domainId, policy, pct)` query `src/db/queries.ts`

## Phase 2: US1 — View and advance pct= step

- [x] T004 Add `GET /api/domains/:id/rollout-next` — parse live DNS pct=, return current step + next step + DNS preview `src/api/router.ts`
- [x] T005 Add `POST /api/domains/:id/rollout-advance` — persist recommended step to domains table `src/api/router.ts`
- [x] T006 Add graduation sequence constant (quarantine 10→50→100, reject 10→50→100) `src/dmarc/rollout.ts`
- [x] T007 Display current pct= progress on domain detail ("Quarantine: 10% of traffic") `dashboard/src/pages/Domain.tsx`
- [x] T008 Add "Increase coverage" button + DNS preview modal with copy-to-clipboard `dashboard/src/pages/Domain.tsx`

## Phase 3: US2 — Safety checks block unsafe graduation

- [x] T009 Block advance in `rollout-next` if pass rate < 90%, return `blocked: true` + reason `src/api/router.ts`
- [x] T010 [P] Warn in `rollout-next` if unknown senders present in last 7-day reports `src/api/router.ts`
- [x] T011 Show block/warning state in dashboard advance button with reason text `dashboard/src/pages/Domain.tsx`

## Phase 4: US3 — Recommended vs actual tracking + rollback suggestion

- [x] T012 Surface "behind schedule" indicator when actual pct < recommended `dashboard/src/pages/Domain.tsx`
- [x] T013 Add rollback suggestion in `check.ts` when pass rate drops >10pp after a step change `src/monitor/check.ts`

## Phase 5: Tests + Polish

- [x] T014 [P] Unit tests for graduation sequence + rollout-next logic `test/dmarc/rollout.test.ts`
- [x] T015 [P] Integration test for rollout-advance endpoint (blocked + allowed cases) `test/api/rollout.test.ts`
- [x] T016 Playwright smoke: domain detail shows pct= progress + advance button `e2e/domain-rollout.spec.mjs`
