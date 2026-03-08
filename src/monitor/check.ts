// Domain monitoring — re-runs DNS checks and diffs against stored baselines.
// Called by the daily cron. Returns a list of changes so the caller can decide
// whether to notify and how to update the baseline.

import { MonitorSubscription } from '../db/types';
import { lookupSpf, lookupDmarc } from '../email/dns-check';

export interface DomainChange {
  field: string;   // human-readable field name
  was: string;     // previous value (empty string = not set)
  now: string;     // current value (empty string = removed)
  severity: 'improved' | 'degraded' | 'changed';
}

export interface CheckMonitorResult {
  subscription: MonitorSubscription;
  changes: DomainChange[];
  // Updated baseline — use this to overwrite stored values
  newBaseline: Pick<MonitorSubscription, 'spf_record' | 'dmarc_policy' | 'dmarc_pct' | 'dmarc_record'>;
}

// DMARC policy strength order: reject > quarantine > none > (missing)
const POLICY_STRENGTH: Record<string, number> = { reject: 3, quarantine: 2, none: 1, '': 0 };

function dmarcSeverity(was: string, now: string): DomainChange['severity'] {
  const wasStrength = POLICY_STRENGTH[was] ?? 0;
  const nowStrength = POLICY_STRENGTH[now] ?? 0;
  if (nowStrength > wasStrength) return 'improved';
  if (nowStrength < wasStrength) return 'degraded';
  return 'changed';
}

function spfSeverity(was: string, now: string): DomainChange['severity'] {
  // Softfail→fail = improved, fail→softfail = degraded, any removal = degraded
  if (!now && was) return 'degraded';
  if (now && !was) return 'improved';
  const wasStrict = was.includes('-all');
  const nowStrict = now.includes('-all');
  if (nowStrict && !wasStrict) return 'improved';
  if (!nowStrict && wasStrict) return 'degraded';
  return 'changed';
}

export async function checkSubscription(sub: MonitorSubscription): Promise<CheckMonitorResult> {
  const [spf, dmarc] = await Promise.all([
    lookupSpf(sub.domain),
    lookupDmarc(sub.domain),
  ]);

  const newBaseline = {
    spf_record: spf?.raw ?? null,
    dmarc_policy: dmarc?.policy ?? null,
    dmarc_pct: dmarc?.pct ?? null,
    dmarc_record: dmarc?.raw ?? null,
  };

  const changes: DomainChange[] = [];

  // SPF record changed
  const wasSpf = sub.spf_record ?? '';
  const nowSpf = newBaseline.spf_record ?? '';
  if (wasSpf !== nowSpf) {
    changes.push({
      field: 'SPF record',
      was: wasSpf,
      now: nowSpf,
      severity: spfSeverity(wasSpf, nowSpf),
    });
  }

  // DMARC policy changed
  const wasPolicy = sub.dmarc_policy ?? '';
  const nowPolicy = newBaseline.dmarc_policy ?? '';
  if (wasPolicy !== nowPolicy) {
    changes.push({
      field: 'DMARC policy',
      was: wasPolicy || '(none)',
      now: nowPolicy || '(missing)',
      severity: dmarcSeverity(wasPolicy, nowPolicy),
    });
  }

  // DMARC pct changed (only report if policy is enforced)
  const wasPct = sub.dmarc_pct ?? 100;
  const nowPct = newBaseline.dmarc_pct ?? 100;
  if (wasPct !== nowPct && nowPolicy && nowPolicy !== 'none') {
    const severity = nowPct > wasPct ? 'improved' : 'degraded';
    changes.push({
      field: 'DMARC enforcement %',
      was: `${wasPct}%`,
      now: `${nowPct}%`,
      severity,
    });
  }

  return { subscription: sub, changes, newBaseline };
}
