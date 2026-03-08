-- Migration 0004: domain monitoring subscriptions
-- Created from a free-check session. Stores SPF/DMARC baselines for daily diff.
CREATE TABLE IF NOT EXISTS monitor_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  domain TEXT NOT NULL,
  session_token TEXT,          -- originating free-check session (for traceability)
  -- Baseline snapshots (seeded from check_results at subscription time)
  spf_record TEXT,             -- raw SPF TXT record
  dmarc_policy TEXT,           -- p= value: none | quarantine | reject
  dmarc_pct INTEGER,           -- pct= value (default 100)
  dmarc_record TEXT,           -- full raw DMARC TXT record
  -- State
  active INTEGER NOT NULL DEFAULT 1,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(email, domain)
);

CREATE INDEX IF NOT EXISTS idx_monitor_active ON monitor_subscriptions(active, last_checked_at);
CREATE INDEX IF NOT EXISTS idx_monitor_domain ON monitor_subscriptions(domain);
