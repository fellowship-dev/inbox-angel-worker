-- Migration 0005: staged pct= rollout tracking
-- Stores recommended graduation step so dashboard can show "behind schedule" if DNS diverges.
ALTER TABLE domains ADD COLUMN rollout_rec_policy TEXT;  -- recommended policy: quarantine | reject
ALTER TABLE domains ADD COLUMN rollout_rec_pct INTEGER;  -- recommended pct: 10 | 50 | 100
