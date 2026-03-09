import { useEffect, useState, useCallback } from 'preact/hooks';
import { getDomains, getDomainStats } from '../api';
import type { Domain, DomainStats } from '../types';
import { AddDomainModal } from '../components/AddDomainModal';

type Status = 'good' | 'warning' | 'danger';

interface DomainRow {
  domain: Domain;
  passRate: number | null;
  status: Status;
}

function computeStatus(policy: Domain['dmarc_policy'], passRate: number | null): Status {
  if (policy === 'none' || policy === null) return 'danger';
  if (passRate !== null && passRate < 0.7) return 'danger';
  if (policy === 'quarantine' || (passRate !== null && passRate < 0.9)) return 'warning';
  return 'good';
}

const STATUS_ICON: Record<Status, string> = { good: '●', warning: '▲', danger: '✕' };
const STATUS_COLOR: Record<Status, string> = { good: '#16a34a', warning: '#d97706', danger: '#dc2626' };
const POLICY_LABEL: Record<string, string> = { none: 'none', quarantine: 'quarantine', reject: 'reject' };

interface Props {
  onUnauthorized: () => void;
}

export function Overview({ onUnauthorized }: Props) {
  const [rows, setRows] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [version, setVersion] = useState(0);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const { domains } = await getDomains();
        if (domains.length === 1) { window.location.hash = `#/domains/${domains[0].id}`; return; }

        // Fetch stats for all domains in parallel
        const statsResults = await Promise.allSettled(
          domains.map((d) => getDomainStats(d.id, 7))
        );

        if (cancelled) return;

        const built: DomainRow[] = domains.map((domain, i) => {
          const result = statsResults[i];
          let passRate: number | null = null;

          if (result.status === 'fulfilled') {
            const stats: DomainStats = result.value;
            const total = stats.stats.reduce((s, r) => s + r.total, 0);
            const passed = stats.stats.reduce((s, r) => s + r.passed, 0);
            passRate = total > 0 ? passed / total : null;
          }

          return { domain, passRate, status: computeStatus(domain.dmarc_policy, passRate) };
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
  }, [version]);

  const protected_ = rows.filter((r) => r.status === 'good').length;
  const needsAction = rows.filter((r) => r.status === 'danger').length;

  return (
    <div>
      {/* Summary strip */}
      <div style={styles.summary}>
        <span><strong>{rows.length}</strong> domain{rows.length !== 1 ? 's' : ''}</span>
        <span style={{ color: STATUS_COLOR.good }}><strong>{protected_}</strong> protected</span>
        {needsAction > 0 && (
          <span style={{ color: STATUS_COLOR.danger }}><strong>{needsAction}</strong> needs action</span>
        )}
        <button style={styles.addBtn} onClick={() => setShowModal(true)}>+ Add domain</button>
      </div>

      {/* Domain list */}
      {loading && <p style={styles.muted}>Loading…</p>}
      {error && <p style={{ color: STATUS_COLOR.danger }}>{error === '401' ? 'Unauthorized — set your API key.' : `Error: ${error}`}</p>}

      {!loading && !error && rows.length === 0 && (
        <div style={styles.empty}>
          <p style={{ margin: '0 0 1rem', color: '#6b7280' }}>No domains yet. Add your first one to start monitoring.</p>
          <button style={styles.primaryBtn} onClick={() => setShowModal(true)}>Protect your first domain →</button>
        </div>
      )}

      {rows.map(({ domain, passRate, status }) => (
        <div
          key={domain.id}
          style={{ ...styles.row, background: hovered === domain.id ? '#f9fafb' : 'transparent' }}
          onClick={() => { window.location.hash = `#/domains/${domain.id}`; }}
          onMouseEnter={() => setHovered(domain.id)}
          onMouseLeave={() => setHovered(null)}
        >
          <span style={{ color: STATUS_COLOR[status], width: '1rem', flexShrink: 0 }}>
            {STATUS_ICON[status]}
          </span>
          <span style={{ flex: 1, fontWeight: 500 }}>{domain.domain}</span>
          <span style={styles.badge}>
            {domain.dmarc_policy ? POLICY_LABEL[domain.dmarc_policy] : '—'}
          </span>
          <span style={{ ...styles.muted, width: '6rem', textAlign: 'right' }}>
            {passRate !== null ? `${Math.round(passRate * 100)}% pass` : '—'}
          </span>
          <span style={styles.muted}>→</span>
        </div>
      ))}

      {showModal && (
        <AddDomainModal
          onClose={() => setShowModal(false)}
          onAdded={reload}
        />
      )}
    </div>
  );
}

const styles = {
  summary: {
    display: 'flex',
    gap: '1.5rem',
    padding: '1rem 0',
    borderBottom: '1px solid #e5e7eb',
    marginBottom: '0.5rem',
    fontSize: '0.9rem',
  } as const,
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
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
    width: '6rem',
    textAlign: 'center' as const,
  },
  muted: {
    color: '#9ca3af',
    fontSize: '0.875rem',
  } as const,
  addBtn: {
    marginLeft: 'auto',
    padding: '0.3rem 0.75rem',
    background: '#111827',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.8rem',
    fontWeight: 600,
    cursor: 'pointer',
  } as const,
  empty: {
    padding: '3rem 0',
    textAlign: 'center' as const,
  },
  primaryBtn: {
    padding: '0.65rem 1.5rem',
    background: '#111827',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.95rem',
    fontWeight: 600,
    cursor: 'pointer',
  } as const,
};
