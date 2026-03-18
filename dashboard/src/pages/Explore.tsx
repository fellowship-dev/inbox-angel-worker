import { useEffect, useState } from 'preact/hooks';
import { getDomainExplore } from '../api';
import type { AnomalySource } from '../types';
import { useIsMobile } from '../hooks';

interface Props {
  domainId: number;
  onUnauthorized: () => void;
}

const WINDOWS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

type Filter = 'all' | 'anomalies';

function isActive(lastSeen: string): boolean {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);
  return new Date(lastSeen) >= cutoff;
}

function failLabel(src: AnomalySource): string {
  if (!src.spf_pass && !src.dkim_pass) return 'SPF + DKIM';
  if (!src.spf_pass) return 'SPF';
  return 'DKIM';
}

function serviceVia(src: AnomalySource): string | null {
  const auth = src.spf_domain || src.dkim_domain;
  if (!auth || auth === src.header_from) return null;
  return auth;
}

export function Explore({ domainId, onUnauthorized }: Props) {
  const [days, setDays] = useState(30);
  const [filter, setFilter] = useState<Filter>('all');
  const [sources, setSources] = useState<AnomalySource[]>([]);
  const [domainName, setDomainName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getDomainExplore(domainId, days)
      .then(({ sources: s, domain }) => { if (!cancelled) { setSources(s); setDomainName(domain); } })
      .catch((e) => {
        if (cancelled) return;
        if (e.message === '401') { onUnauthorized(); return; }
        setError(e.message ?? 'Failed to load');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [domainId, days]);

  const visible = filter === 'anomalies'
    ? sources.filter(s => !s.spf_pass || !s.dkim_pass)
    : sources;

  const anomalyCount = sources.filter(s => !s.spf_pass || !s.dkim_pass).length;

  return (
    <div>
      <a href={`#/domains/${domainId}`} style={s.back}>← {domainName ?? '...'}</a>

      <div style={s.pageHeader}>
        <h2 style={s.title}>Sources</h2>
        <div style={s.controls}>
          <div style={s.pills}>
            <button style={{ ...s.pill, ...(filter === 'all' ? s.pillActive : {}) }} onClick={() => setFilter('all')}>All</button>
            <button style={{ ...s.pill, ...(filter === 'anomalies' ? s.pillActiveDanger : {}) }} onClick={() => setFilter('anomalies')}>
              Anomalies{anomalyCount > 0 && <span style={s.badge}>{anomalyCount}</span>}
            </button>
          </div>
          <div style={s.pills}>
            {WINDOWS.map(w => (
              <button key={w.days} style={{ ...s.pill, ...(days === w.days ? s.pillActive : {}) }} onClick={() => setDays(w.days)}>
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && <p style={s.muted}>Loading…</p>}
      {error && <p style={{ color: '#dc2626' }}>Error: {error}</p>}

      {!loading && !error && visible.length === 0 && (
        <div style={s.emptyState}>
          <div style={s.emptyIcon}>{filter === 'anomalies' ? '✓' : '○'}</div>
          <div style={s.emptyTitle}>
            {filter === 'anomalies' ? `No anomalies in the last ${days} days` : `No sources in the last ${days} days`}
          </div>
          <div style={s.emptyHint}>
            {filter === 'anomalies' ? 'All sending sources are passing DMARC.' : 'No DMARC reports received yet.'}
          </div>
        </div>
      )}

      {!loading && visible.length > 0 && (
        mobile ? (
          // Card list on mobile
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {visible.map((src) => {
              const passing = src.spf_pass && src.dkim_pass;
              const active = isActive(src.last_seen);
              const via = serviceVia(src);
              const stale = !passing && !active;
              return (
                <div key={`${src.source_ip}-${src.header_from}`} style={{ ...s.card, opacity: stale ? 0.5 : 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.4rem' }}>
                    <a href={`#/domains/${domainId}/reports/${src.last_seen}`} style={{ textDecoration: 'none' }}>
                      {(src.org || src.base_domain)
                        ? <span style={s.providerName}>{src.org ?? src.base_domain}</span>
                        : <code style={s.ip}>{src.source_ip}</code>
                      }
                    </a>
                    {passing
                      ? <span style={s.passBadge}>✓ Passing</span>
                      : <span style={s.failBadge}>{failLabel(src)} fail</span>
                    }
                  </div>
                  {(src.org || src.base_domain) && <code style={s.ipSub}>{src.source_ip}</code>}
                  {src.header_from && <div style={s.sub}>{src.header_from}</div>}
                  {via && <div style={s.sub}>via {via}</div>}
                  <div style={{ display: 'flex', gap: '1rem', marginTop: '0.4rem', fontSize: '0.75rem', color: '#9ca3af' }}>
                    <span>{src.total.toLocaleString()} msg</span>
                    <span>{src.first_seen.slice(5)} – {src.last_seen.slice(5)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          // Full table on desktop
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Source</th>
                <th style={s.th}>Status</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Messages</th>
                <th style={s.th}>First seen</th>
                <th style={s.th}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((src) => {
                const passing = src.spf_pass && src.dkim_pass;
                const active = isActive(src.last_seen);
                const via = serviceVia(src);
                const stale = !passing && !active;
                return (
                  <tr key={`${src.source_ip}-${src.header_from}`} style={{ opacity: stale ? 0.5 : 1 }}>
                    <td style={s.td}>
                      <a href={`#/domains/${domainId}/reports/${src.last_seen}`} style={s.ipLink}>
                        {(src.org || src.base_domain)
                          ? <span style={s.providerName}>{src.org ?? src.base_domain}</span>
                          : <code style={s.ip}>{src.source_ip}</code>
                        }
                      </a>
                      {(src.org || src.base_domain) && <code style={s.ipSub}>{src.source_ip}</code>}
                      {src.header_from && <div style={s.sub}>{src.header_from}</div>}
                      {via && <div style={s.sub}>via {via}</div>}
                    </td>
                    <td style={s.td}>
                      {passing
                        ? <span style={s.passBadge}>✓ Passing</span>
                        : <span style={s.failBadge}>{failLabel(src)} fail</span>
                      }
                    </td>
                    <td style={{ ...s.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{src.total.toLocaleString()}</td>
                    <td style={{ ...s.td, ...s.dateCell }}>{src.first_seen.slice(5)}</td>
                    <td style={{ ...s.td, ...s.dateCell }}>{src.last_seen.slice(5)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}
    </div>
  );
}

const s = {
  back: { fontSize: '0.875rem', color: '#6b7280', textDecoration: 'none', display: 'inline-block', marginBottom: '1.5rem' } as const,
  pageHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '2rem', gap: '1rem', flexWrap: 'wrap' as const },
  title: { margin: 0, fontSize: '1.5rem', fontWeight: 700 },
  controls: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' as const, alignItems: 'center' },
  pills: { display: 'flex', gap: '0.25rem' } as const,
  pill: { display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.25rem 0.7rem', border: '1px solid #e5e7eb', borderRadius: '20px', fontSize: '0.8rem', cursor: 'pointer', background: '#fff', color: '#6b7280' } as const,
  pillActive: { background: '#111827', color: '#fff', borderColor: '#111827' } as const,
  pillActiveDanger: { background: '#dc2626', color: '#fff', borderColor: '#dc2626' } as const,
  badge: { background: 'rgba(255,255,255,0.25)', borderRadius: '10px', padding: '0 0.35rem', fontSize: '0.7rem', fontWeight: 700 } as const,
  // Desktop table
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem' },
  th: { textAlign: 'left' as const, padding: '0.5rem 0.75rem', borderBottom: '1px solid #e5e7eb', fontSize: '0.7rem', color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  td: { padding: '0.65rem 0.75rem', borderBottom: '1px solid #f3f4f6', color: '#374151', verticalAlign: 'top' as const },
  ipLink: { textDecoration: 'none' } as const,
  dateCell: { fontSize: '0.8rem', color: '#6b7280', fontFamily: 'monospace' } as const,
  // Mobile cards
  card: { padding: '0.75rem', border: '1px solid #f3f4f6', borderRadius: '6px', background: '#fff' } as const,
  // Shared
  ip: { fontFamily: 'monospace', fontSize: '0.8rem', color: '#111827' } as const,
  providerName: { fontSize: '0.875rem', fontWeight: 600, color: '#111827' } as const,
  ipSub: { display: 'block', fontFamily: 'monospace', fontSize: '0.75rem', color: '#9ca3af', marginTop: '0.1rem' } as const,
  sub: { fontSize: '0.75rem', color: '#9ca3af', marginTop: '0.15rem' } as const,
  passBadge: { display: 'inline-block', background: '#dcfce7', color: '#16a34a', fontSize: '0.7rem', fontWeight: 600, padding: '0.15rem 0.45rem', borderRadius: '4px' } as const,
  failBadge: { display: 'inline-block', background: '#fee2e2', color: '#dc2626', fontSize: '0.7rem', fontWeight: 600, padding: '0.15rem 0.45rem', borderRadius: '4px' } as const,
  emptyState: { textAlign: 'center' as const, padding: '3rem 1rem' },
  emptyIcon: { fontSize: '2rem', color: '#9ca3af', marginBottom: '0.75rem' },
  emptyTitle: { fontWeight: 600, color: '#111827', marginBottom: '0.4rem' } as const,
  emptyHint: { fontSize: '0.875rem', color: '#9ca3af' } as const,
  muted: { color: '#9ca3af' } as const,
};
