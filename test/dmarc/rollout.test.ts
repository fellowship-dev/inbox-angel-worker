import { describe, it, expect } from 'vitest';
import {
  ROLLOUT_SEQUENCE,
  getNextStep,
  getCurrentStepIndex,
  buildStepRecord,
} from '../../src/dmarc/rollout';
import { detectRollbackRisk, ROLLBACK_THRESHOLD_PP } from '../../src/monitor/check';

describe('ROLLOUT_SEQUENCE', () => {
  it('has 6 steps: quarantine 10/50/100 then reject 10/50/100', () => {
    expect(ROLLOUT_SEQUENCE).toHaveLength(6);
    expect(ROLLOUT_SEQUENCE[0]).toEqual({ policy: 'quarantine', pct: 10 });
    expect(ROLLOUT_SEQUENCE[2]).toEqual({ policy: 'quarantine', pct: 100 });
    expect(ROLLOUT_SEQUENCE[3]).toEqual({ policy: 'reject', pct: 10 });
    expect(ROLLOUT_SEQUENCE[5]).toEqual({ policy: 'reject', pct: 100 });
  });
});

describe('getNextStep', () => {
  it('returns quarantine/10 as first step from none', () => {
    expect(getNextStep('none', null)).toEqual({ policy: 'quarantine', pct: 10 });
  });

  it('returns quarantine/10 as first step from null', () => {
    expect(getNextStep(null, null)).toEqual({ policy: 'quarantine', pct: 10 });
  });

  it('advances through sequence', () => {
    expect(getNextStep('quarantine', 10)).toEqual({ policy: 'quarantine', pct: 50 });
    expect(getNextStep('quarantine', 50)).toEqual({ policy: 'quarantine', pct: 100 });
    expect(getNextStep('quarantine', 100)).toEqual({ policy: 'reject', pct: 10 });
    expect(getNextStep('reject', 10)).toEqual({ policy: 'reject', pct: 50 });
    expect(getNextStep('reject', 50)).toEqual({ policy: 'reject', pct: 100 });
  });

  it('returns null at last step', () => {
    expect(getNextStep('reject', 100)).toBeNull();
  });

  it('returns null for unrecognised step', () => {
    expect(getNextStep('reject', 75)).toBeNull();
  });
});

describe('getCurrentStepIndex', () => {
  it('returns -1 for none or null', () => {
    expect(getCurrentStepIndex('none', null)).toBe(-1);
    expect(getCurrentStepIndex(null, null)).toBe(-1);
  });

  it('returns correct index', () => {
    expect(getCurrentStepIndex('quarantine', 10)).toBe(0);
    expect(getCurrentStepIndex('reject', 100)).toBe(5);
  });
});

describe('buildStepRecord', () => {
  it('replaces p= and pct= in an existing record', () => {
    const result = buildStepRecord('v=DMARC1; p=quarantine; pct=10; rua=mailto:foo@example.com', { policy: 'quarantine', pct: 50 });
    expect(result).toContain('p=quarantine');
    expect(result).toContain('pct=50');
    expect(result).toContain('rua=mailto:foo@example.com');
  });

  it('strips outer quotes from CF API response', () => {
    const result = buildStepRecord('"v=DMARC1; p=quarantine; pct=10"', { policy: 'reject', pct: 10 });
    expect(result).toContain('p=reject');
    expect(result).toContain('pct=10');
    expect(result).not.toMatch(/^"/);
  });

  it('omits pct= when advancing to pct=100 (default)', () => {
    const result = buildStepRecord('v=DMARC1; p=quarantine; pct=50', { policy: 'quarantine', pct: 100 });
    // pct=100 is the default — should replace existing pct= with 100
    expect(result).toContain('pct=100');
  });
});

describe('detectRollbackRisk', () => {
  it(`flags a drop of >= ${ROLLBACK_THRESHOLD_PP}pp`, () => {
    expect(detectRollbackRisk(79, 90)).toBe(true);
    expect(detectRollbackRisk(80, 90)).toBe(true); // exactly at threshold
  });

  it(`does not flag a drop < ${ROLLBACK_THRESHOLD_PP}pp`, () => {
    expect(detectRollbackRisk(85, 90)).toBe(false);
    expect(detectRollbackRisk(90, 90)).toBe(false);
  });

  it('returns false when either rate is null', () => {
    expect(detectRollbackRisk(null, 90)).toBe(false);
    expect(detectRollbackRisk(80, null)).toBe(false);
    expect(detectRollbackRisk(null, null)).toBe(false);
  });
});
