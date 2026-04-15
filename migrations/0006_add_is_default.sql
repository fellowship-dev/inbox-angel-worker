-- Migration 0005: default domain model
-- Adds is_default flag to domains table.
-- Exactly one domain has is_default=1 at any time — the "home base" for
-- reports.<domain> infrastructure, FROM_EMAIL, and default RUA address.
ALTER TABLE domains ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_is_default ON domains(is_default) WHERE is_default = 1;

-- Backfill: if exactly one domain exists, make it the default.
-- Safe no-op for fresh installs (no rows) and multi-domain deploys (ambiguous — user must set manually).
UPDATE domains SET is_default = 1
WHERE id = (SELECT id FROM domains ORDER BY created_at ASC LIMIT 1)
  AND (SELECT COUNT(*) FROM domains) = 1;
