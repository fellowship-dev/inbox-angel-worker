# Tasks: Multi-Domain Default Domain Model

**Branch**: `14-multi-domain-default` | **Spec**: spec.md | **Plan**: plan.md

## Phase 1: Migration & Data Layer (US1 — Default Domain)

- [x] T001 Add `is_default` column + backfill migration `migrations/0005_add_is_default.sql`
- [x] T002 Update `enrichEnv()` to query `SELECT domain FROM domains WHERE is_default=1` as base domain source `src/env-utils.ts`
- [x] T003 Add `PUT /api/domains/:id/set-default` endpoint (atomic swap, invalidates cache) `src/api/router.ts`
- [x] T004 Update `POST /api/settings/base-domain` (onboarding step 0) to set `is_default=1` on domain row `src/api/router.ts`

## Phase 2: Zone Auto-Discovery (US2 — Zone Picker)

- [x] T005 Add `GET /api/zones` endpoint (proxy CF `/zones`, return name/id/status) `src/api/router.ts`
- [x] T006 [P] Add `fetchZones()` API helper `dashboard/src/api.ts`
- [x] T007 [P] Add zone picker (`<select>` + manual fallback) to onboarding step 0 `dashboard/src/pages/Onboarding.tsx`
- [x] T008 Add zone picker to add-domain form `dashboard/src/pages/AddDomain.tsx`

## Phase 3: Subsequent Domain Flow (US3 — Reuse Default Infrastructure)

- [x] T009 Update `POST /api/domains` to pre-fill `rua_address` from default domain at insert time `src/api/router.ts` *(no-op: already uses reportsDomain() which now falls back to is_default=1 via T002)*
- [x] T010 Add warning UI when user changes default domain (auth records need re-apply) `dashboard/src/pages/DomainSettings.tsx`

## Phase 4: Polish & Tests

- [x] T011 [P] Write vitest tests: `enrichEnv()` default domain derivation, `GET /api/zones` mock, `set-default` atomicity `test/api/multi-domain.test.ts`
- [x] T012 [P] Write vitest test: migration backfill (single existing domain gets `is_default=1`) `test/api/multi-domain.test.ts`
- [x] T013 Update `worker-configuration.d.ts` if any new bindings needed `worker-configuration.d.ts` *(no-op: no new CF bindings, only D1 column + existing env var)*
- [ ] T014 Playwright smoke: zone picker visible, second domain inherits default RUA `e2e/` *(blocked: requires /deploy first, then run /test-prod)*
