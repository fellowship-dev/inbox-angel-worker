-- Migration 0003: add session_token to check_results for front-end polling
-- Each free-check session gets a unique token embedded in the recipient address:
--   check-{token}@reports.inboxangel.io
-- The front-end polls GET /api/check-sessions/:token until the result appears.
ALTER TABLE check_results ADD COLUMN session_token TEXT;
CREATE INDEX IF NOT EXISTS idx_check_results_token ON check_results(session_token);
