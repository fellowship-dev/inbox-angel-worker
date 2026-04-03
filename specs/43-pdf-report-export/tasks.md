# Tasks: PDF Summary Report Export

## Phase 1: Setup

- [x] T001 Add `jspdf` dependency `dashboard/package.json`

## Phase 2: US1 — Domain Health PDF (P1)

- [x] T002 Add `getCheckSummary()` query (latest DMARC/SPF/DKIM/MTA-STS pass/fail per domain) `src/db/queries.ts`
- [x] T003 Add `GET /api/domains/:id/check-summary` route (auth-protected, calls getCheckSummary) `src/api/router.ts`
- [x] T004 Add `fetchCheckSummary()` API client function `dashboard/src/api.ts`
- [x] T005 Create `PdfReport.ts` — jsPDF builder: title, date, per-domain status table, page breaks `dashboard/src/components/PdfReport.ts`
- [x] T006 Add "Export PDF" button to Overview page; on click: fetch all domains + summaries, call PdfReport, trigger download `dashboard/src/pages/Overview.tsx`

## Phase 3: US2 — Pass/Fail Rates & Recommendations (P2)

- [x] T007 Create `pdfRecommendations.ts` — derive plain-language recommendations from check summary `dashboard/src/utils/pdfRecommendations.ts`
- [x] T008 Extend `PdfReport.ts` — add aggregate pass/fail rates section + recommendations per domain `dashboard/src/components/PdfReport.ts`

## Phase 4: US3 — Historical Trend (P3)

- [x] T009 Fetch 90-day stats per domain during PDF export; aggregate daily stats into weekly pass rates `dashboard/src/pages/Overview.tsx`
- [x] T010 Extend `PdfReport.ts` — add trend table (weekly pass %) per domain `dashboard/src/components/PdfReport.ts`

## Phase 5: Tests & Polish

- [x] T011 Unit tests for `pdfRecommendations.ts` (13 tests) `test/unit/pdfRecommendations.test.ts`
- [x] T012 Unit tests for `getCheckSummary()` query (6 tests) `test/unit/checkSummary.test.ts`
- [x] T013 Playwright smoke test: click "Export PDF", verify file download triggered `test/e2e/pdf-export.mjs`
