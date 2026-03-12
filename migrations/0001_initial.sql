-- InboxAngel D1 Schema — Migration 0001
-- Single-tenant: one instance per deployment

-- ============================================================
-- Domains
-- Monitor multiple domains per instance
-- ============================================================
CREATE TABLE IF NOT EXISTS domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,             -- e.g. "company.com"
  rua_address TEXT NOT NULL,               -- e.g. "abc123@reports.inboxangel.com"
  -- Current DMARC policy (refreshed on each report ingestion)
  dmarc_policy TEXT,                       -- none | quarantine | reject
  dmarc_pct INTEGER,                       -- 0-100
  spf_record TEXT,                         -- raw SPF record
  -- Authorization record provisioned in Cloudflare DNS
  auth_record_provisioned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);

-- ============================================================
-- Free Check Results
-- One row per free check email received at check@reports.inboxangel.com
-- Not tied to a customer — anonymous
-- ============================================================
CREATE TABLE IF NOT EXISTS check_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_email TEXT NOT NULL,             -- who sent the check email
  from_domain TEXT NOT NULL,            -- extracted domain
  -- SPF
  spf_result TEXT,                      -- pass | fail | softfail | neutral | none | permerror | temperror
  spf_domain TEXT,                      -- domain that was checked
  spf_record TEXT,                      -- raw TXT record found
  -- DKIM
  dkim_result TEXT,                     -- pass | fail | none
  dkim_domain TEXT,                     -- signing domain (d= tag)
  -- DMARC
  dmarc_result TEXT,                    -- pass | fail | none
  dmarc_policy TEXT,                    -- none | quarantine | reject
  dmarc_record TEXT,                    -- raw TXT record found
  -- Overall
  overall_status TEXT NOT NULL,         -- protected | at_risk | exposed
  report_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_check_results_domain ON check_results(from_domain);

-- ============================================================
-- Aggregate Reports
-- One row per DMARC RUA XML file received
-- ============================================================
CREATE TABLE IF NOT EXISTS aggregate_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  -- Report metadata (from <report_metadata>)
  org_name TEXT NOT NULL,               -- reporting org (e.g. "Google Inc.")
  report_id TEXT NOT NULL,
  date_begin INTEGER NOT NULL,          -- unix timestamp
  date_end INTEGER NOT NULL,
  -- Summary
  total_count INTEGER NOT NULL DEFAULT 0,
  pass_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  -- Raw XML stored for reprocessing
  raw_xml TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(domain_id, report_id)          -- deduplicate re-deliveries
);

CREATE INDEX IF NOT EXISTS idx_agg_reports_domain ON aggregate_reports(domain_id);
CREATE INDEX IF NOT EXISTS idx_agg_reports_date ON aggregate_reports(date_begin);

-- ============================================================
-- Report Records
-- One row per <record> inside an aggregate report
-- Each record = a sending IP + pass/fail counts
-- ============================================================
CREATE TABLE IF NOT EXISTS report_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES aggregate_reports(id) ON DELETE CASCADE,
  -- Source
  source_ip TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,     -- message count from this IP
  -- Policy evaluated
  disposition TEXT NOT NULL,            -- none | quarantine | reject
  -- DKIM
  dkim_result TEXT,                     -- pass | fail
  dkim_domain TEXT,
  -- SPF
  spf_result TEXT,                      -- pass | fail
  spf_domain TEXT,
  -- Header from (the domain in From: header)
  header_from TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_records_report ON report_records(report_id);
CREATE INDEX IF NOT EXISTS idx_records_ip ON report_records(source_ip);
