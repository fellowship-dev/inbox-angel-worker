// DMARC staged rollout helpers
// Graduation sequence: quarantine 10→50→100, then reject 10→50→100.
// Each step is gated behind a pass-rate threshold to prevent mail loss.

export interface RolloutStep {
  policy: 'quarantine' | 'reject';
  pct: number;
}

export const ROLLOUT_SEQUENCE: RolloutStep[] = [
  { policy: 'quarantine', pct: 10 },
  { policy: 'quarantine', pct: 50 },
  { policy: 'quarantine', pct: 100 },
  { policy: 'reject', pct: 10 },
  { policy: 'reject', pct: 50 },
  { policy: 'reject', pct: 100 },
];

// Minimum pass rate (0-100) required to advance to the next step.
export const PASS_RATE_THRESHOLD = 90;

/**
 * Returns the next step after the given policy+pct, or null if already at the last step.
 */
export function getNextStep(policy: string | null, pct: number | null): RolloutStep | null {
  if (policy === 'none' || policy === null) {
    return ROLLOUT_SEQUENCE[0]; // start at quarantine/10
  }
  const currentIndex = ROLLOUT_SEQUENCE.findIndex(
    (s) => s.policy === policy && s.pct === (pct ?? 100)
  );
  if (currentIndex === -1 || currentIndex === ROLLOUT_SEQUENCE.length - 1) {
    return null; // fully graduated or unrecognised step
  }
  return ROLLOUT_SEQUENCE[currentIndex + 1];
}

/**
 * Returns the current step index (0-based) within ROLLOUT_SEQUENCE, or -1 if not matched.
 * policy='none' is treated as "not started" (index -1).
 */
export function getCurrentStepIndex(policy: string | null, pct: number | null): number {
  if (policy === 'none' || policy === null) return -1;
  return ROLLOUT_SEQUENCE.findIndex(
    (s) => s.policy === policy && s.pct === (pct ?? 100)
  );
}

/**
 * Builds the DMARC TXT record string for a given step, preserving other tags from the existing record.
 * Replaces p= and pct= in place; all other tags are kept.
 */
export function buildStepRecord(existingRecord: string, step: RolloutStep): string {
  // Strip outer quotes CF API may have added
  let record = existingRecord.replace(/^"|"$/g, '').trim();

  // Replace or insert p=
  if (/\bp=/.test(record)) {
    record = record.replace(/\bp=[^\s;]+/, `p=${step.policy}`);
  } else {
    record = record.replace(/^v=DMARC1\s*;?\s*/, `v=DMARC1; p=${step.policy}; `);
  }

  // Replace or insert pct=
  if (/\bpct=/.test(record)) {
    record = record.replace(/\bpct=\d+/, `pct=${step.pct}`);
  } else if (step.pct !== 100) {
    // Only append pct= when it's not the default (100 = implicit)
    record = record.replace(/;\s*$/, '') + `; pct=${step.pct}`;
  }

  return record;
}
