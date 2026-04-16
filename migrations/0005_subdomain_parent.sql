-- Migration 0005: Subdomain support
-- Add parent_id to domains to link subdomains to their apex domain
ALTER TABLE domains ADD COLUMN parent_id INTEGER REFERENCES domains(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_domains_parent ON domains(parent_id);
