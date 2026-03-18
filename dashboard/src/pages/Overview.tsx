import { useEffect, useState } from 'preact/hooks';
import { getDomains, getDomainStats, getWizardState } from '../api';
import type { Domain, DomainStats, WizardState } from '../types';
import { useIsMobile } from '../hooks';

type Status = 'good' | 'warning' | 'danger';

interface DomainRow {
  domain: Domain;
  passRate: number | null;
  total: number;
  failed: number;
  status: Status;
  wizardComplete: number;
  wizardTotal: number;
}

function computeStatus(policy: Domain['dmarc_policy'], passRate: number | null): Status {
  if (policy === 'none' || policy === null) return 'danger';
  if (passRate !== null && passRate < 0.7) return 'danger';
  if (policy === 'quarantine' || (passRate !== null && passRate < 0.9)) return 'warning';
  return 'good';
}

const STATUS_COLOR: Record<Status, string> = { good: '#16a34a', warning: '#d97706', danger: '#dc2626' };
const POLICY_LABEL: Record<string, string> = { none: 'none', quarantine: 'quar.', reject: 'reject' };

// Lighthouse-style score circle — SVG ring with number inside
function ScoreCircle({ score }: { score: number | null }) {
  const size = 36;
  const r = 14;
  const cx = size / 2;
  const circumference = 2 * Math.PI * r;
  const color = score === null ? '#d1d5db'
    : score >= 95 ? '#0cce6b'
    : score >= 70 ? '#ffa400'
    : '#ff4e42';
  const offset = score === null ? circumference : circumference * (1 - score / 100);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={cx} cy={cx} r={r} fill="none" stroke="#e5e7eb" strokeWidth="2" />
      {score !== null && (
        <circle
          cx={cx} cy={cx} r={r} fill="none"
          stroke={color} strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cx})`}
        />
      )}
      <text
        x={cx} y={cx}
        dominantBaseline="central" textAnchor="middle"
        fontSize="8" fontWeight="700" fill={color}
      >
        {score !== null ? score : '—'}
      </text>
    </svg>
  );
}

interface Props {
  onUnauthorized: () => void;
}

export function Overview({ onUnauthorized }: Props) {
  const [rows, setRows] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const mobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const { domains } = await getDomains();

        const [statsResults, wizardResults] = await Promise.all([
          Promise.allSettled(domains.map((d) => getDomainStats(d.id, 7))),
          Promise.allSettled(domains.map((d) => getWizardState(d.id))),
        ]);

        if (cancelled) return;

        const built: DomainRow[] = domains.map((domain, i) => {
          const result = statsResults[i];
          let passRate: number | null = null;

          let total = 0, failed = 0;
          if (result.status === 'fulfilled') {
            const stats: DomainStats = result.value;
            total = stats.stats.reduce((s, r) => s + r.total, 0);
            const passed = stats.stats.reduce((s, r) => s + r.passed, 0);
            failed = stats.stats.reduce((s, r) => s + r.failed, 0);
            passRate = total > 0 ? passed / total : null;
          }

          let wizardComplete = 0;
          const wizardTotal = 5;
          if (wizardResults[i].status === 'fulfilled') {
            const ws = wizardResults[i].value as WizardState;
            wizardComplete = Object.values(ws).filter(v => v === 'complete').length;
          }

          return { domain, passRate, total, failed, status: computeStatus(domain.dmarc_policy, passRate), wizardComplete, wizardTotal };
        });

        setRows(built);
      } catch (e: any) {
        if (cancelled) return;
        if (e.message === '401') { onUnauthorized(); return; }
        setError(e.message ?? 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  const protected_ = rows.filter((r) => r.status === 'good').length;
  const needsAction = rows.filter((r) => r.status === 'danger').length;

  return (
    <div>
      {/* Summary strip */}
      <div style={{ ...styles.summary, flexWrap: 'wrap', gap: mobile ? '0.75rem' : '1.5rem' }}>
        <span><strong>{rows.length}</strong> domain{rows.length !== 1 ? 's' : ''}</span>
        <span style={{ color: STATUS_COLOR.good }}><strong>{protected_}</strong> protected</span>
        {needsAction > 0 && (
          <span style={{ color: STATUS_COLOR.danger }}><strong>{needsAction}</strong> needs action</span>
        )}
        <a href="#/add" style={{ ...styles.addBtn, marginLeft: mobile ? '0' : 'auto', marginTop: mobile ? '0.25rem' : '0' }}>
          + Add domain
        </a>
      </div>

      {loading && <p style={styles.muted}>Loading…</p>}
      {error && <p style={{ color: STATUS_COLOR.danger }}>{error === '401' ? 'Unauthorized — set your API key.' : `Error: ${error}`}</p>}

      {!loading && !error && rows.length === 0 && (
        <div style={styles.empty}>
          <p style={{ margin: '0 0 1rem', color: '#6b7280' }}>No domains yet. Add your first one to get started.</p>
          <a href="#/setup" style={styles.primaryBtn}>Get started →</a>
        </div>
      )}

      {rows.map(({ domain, passRate, total, failed, wizardComplete, wizardTotal }) => {
        const score = passRate !== null ? Math.round(passRate * 100) : null;
        const setupIncomplete = wizardComplete < wizardTotal;
        return (
          <div
            key={domain.id}
            style={{ ...styles.row, background: hovered === domain.id ? '#f9fafb' : 'transparent' }}
            onClick={() => { window.location.hash = `#/domains/${domain.id}`; }}
            onMouseEnter={() => setHovered(domain.id)}
            onMouseLeave={() => setHovered(null)}
          >
            <ScoreCircle score={score} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                {domain.domain}
              </span>
              {setupIncomplete && (
                <a
                  href={`#/domains/${domain.id}/setup/2`}
                  onClick={(e: Event) => e.stopPropagation()}
                  style={{ fontSize: '0.7rem', color: '#d97706', textDecoration: 'none' }}
                >
                  {wizardComplete}/{wizardTotal} steps — Continue setup →
                </a>
              )}
            </div>
            <span style={styles.badge}>
              {domain.dmarc_policy ? POLICY_LABEL[domain.dmarc_policy] : '—'}
            </span>
            {!mobile && total > 0 && (
              <span style={styles.stat}>{total.toLocaleString()} msg</span>
            )}
            {!mobile && failed > 0 && (
              <span style={{ ...styles.stat, color: '#dc2626' }}>{failed.toLocaleString()} failed</span>
            )}
            <span style={styles.muted}>→</span>
          </div>
        );
      })}
    </div>
  );
}

const styles = {
  summary: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.5rem',
    padding: '1rem 0',
    borderBottom: '1px solid #e5e7eb',
    marginBottom: '0.5rem',
    fontSize: '0.9rem',
  } as const,
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.85rem 0.75rem',
    borderBottom: '1px solid #f3f4f6',
    cursor: 'pointer',
    borderRadius: '6px',
    transition: 'background 0.1s',
  } as const,
  badge: {
    fontSize: '0.75rem',
    padding: '0.2rem 0.5rem',
    borderRadius: '4px',
    background: '#f3f4f6',
    color: '#374151',
    flexShrink: 0,
  } as const,
  muted: {
    color: '#9ca3af',
    fontSize: '0.875rem',
  } as const,
  stat: {
    fontSize: '0.85rem',
    flexShrink: 0,
    color: '#6b7280',
    fontVariantNumeric: 'tabular-nums',
  } as const,
  addBtn: {
    padding: '0.3rem 0.75rem',
    background: '#111827',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.8rem',
    fontWeight: 600,
    cursor: 'pointer',
    textDecoration: 'none',
    display: 'inline-block',
    flexShrink: 0,
  } as const,
  empty: {
    padding: '3rem 0',
    textAlign: 'center' as const,
  },
  primaryBtn: {
    display: 'inline-block',
    padding: '0.65rem 1.5rem',
    background: '#111827',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.95rem',
    fontWeight: 600,
    cursor: 'pointer',
    textDecoration: 'none',
  } as const,
};
