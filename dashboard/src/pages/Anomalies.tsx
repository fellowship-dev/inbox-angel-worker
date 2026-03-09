import { useEffect, useState } from 'preact/hooks';
import { getDomainAnomalies } from '../api';
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

// Is this source still active? last_seen within last 2 days
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

export function Anomalies({ domainId, onUnauthorized }: Props) {
  const [days, setDays] = useState(30);
  const [anomalies, setAnomalies] = useState<AnomalySource[]>([]);
  const [domainName, setDomainName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getDomainAnomalies(domainId, days)
      .then(({ anomalies, domain }) => { if (!cancelled) { setAnomalies(anomalies); setDomainName(domain); } })
      .catch((e) => {
        if (cancelled) return;
        if (e.message === '401') { onUnauthorized(); return; }
        setError(e.message ?? 'Failed to load');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [domainId, days]);

  const active = anomalies.filter(a => isActive(a.last_seen));
  const stale  = anomalies.filter(a => !isActive(a.last_seen));

  return (
    <div>
      <a href={`#/domains/${domainId}`} style={s.back}>← {domainName ?? 'Back'}</a>

      <div style={s.pageHeader}>
        <h2 style={s.title}>Anomalies</h2>
        <div style={s.pills}>
          {WINDOWS.map(w => (
            <button
              key={w.days}
              style={{ ...s.pill, ...(days === w.days ? s.pillActive : {}) }}
              onClick={() => setDays(w.days)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <p style={s.muted}>Loading…</p>}
      {error && <p style={{ color: '#dc2626' }}>Error: {error}</p>}

      {!loading && !error && anomalies.length === 0 && (
        <div style={s.emptyState}>
          <div style={s.emptyIcon}>✓</div>
          <div style={s.emptyTitle}>No anomalies in the last {days} days</div>
          <div style={s.emptyHint}>All sending sources are passing DMARC.</div>
        </div>
      )}

      {!loading && anomalies.length > 0 && (
        <>
          {active.length > 0 && (
            <section style={s.section}>
              <h3 style={{ ...s.sectionTitle, color: '#dc2626' }}>
                Active — {active.length} source{active.length !== 1 ? 's' : ''}
              </h3>
              <SourceTable sources={active} domainId={domainId} mobile={mobile} />
            </section>
          )}

          {stale.length > 0 && (
            <section style={s.section}>
              <h3 style={s.sectionTitle}>
                Older — {stale.length} source{stale.length !== 1 ? 's' : ''}
                <span style={s.staleHint}> · not seen in 2+ days, may be resolved</span>
              </h3>
              <SourceTable sources={stale} domainId={domainId} stale mobile={mobile} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

function SourceTable({ sources, domainId, stale, mobile }: { sources: AnomalySource[]; domainId: number; stale?: boolean; mobile?: boolean }) {
  const opacity = stale ? 0.55 : 1;
  if (mobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {sources.map((src) => {
          const via = serviceVia(src);
          return (
            <div key={`${src.source_ip}-${src.header_from}`} style={{ ...s.card, opacity }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.4rem' }}>
                <a href={`#/domains/${domainId}/reports/${src.last_seen}`} style={{ textDecoration: 'none' }}>
                  <code style={s.ip}>{src.source_ip}</code>
                </a>
                <span style={s.failBadge}>{failLabel(src)}</span>
              </div>
              {(src.org || src.base_domain) && <div style={s.sub}>{src.org ?? src.base_domain}</div>}
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
    );
  }
  return (
    <table style={s.table}>
      <thead>
        <tr>
          <th style={s.th}>Source</th>
          <th style={s.th}>Failing</th>
          <th style={{ ...s.th, textAlign: 'right' }}>Messages</th>
          <th style={s.th}>First seen</th>
          <th style={s.th}>Last seen</th>
        </tr>
      </thead>
      <tbody>
        {sources.map((src) => {
          const via = serviceVia(src);
          return (
            <tr key={`${src.source_ip}-${src.header_from}`} style={{ opacity }}>
              <td style={s.td}>
                <a href={`#/domains/${domainId}/reports/${src.last_seen}`} style={s.ipLink}>
                  <code style={s.ip}>{src.source_ip}</code>
                </a>
                {(src.org || src.base_domain) && <div style={s.sub}>{src.org ?? src.base_domain}</div>}
                {src.header_from && <div style={s.sub}>{src.header_from}</div>}
                {via && <div style={s.sub}>via {via}</div>}
              </td>
              <td style={s.td}>
                <span style={s.failBadge}>{failLabel(src)}</span>
              </td>
              <td style={{ ...s.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {src.total.toLocaleString()}
              </td>
              <td style={{ ...s.td, ...s.dateCell }}>{src.first_seen.slice(5)}</td>
              <td style={{ ...s.td, ...s.dateCell }}>{src.last_seen.slice(5)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const s = {
  back: { fontSize: '0.875rem', color: '#6b7280', textDecoration: 'none', display: 'inline-block', marginBottom: '1.5rem' } as const,
  pageHeader: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '2rem', gap: '1rem', flexWrap: 'wrap' as const },
  title: { margin: 0, fontSize: '1.5rem', fontWeight: 700 },

  pills: { display: 'flex', gap: '0.35rem' } as const,
  pill: { padding: '0.25rem 0.7rem', border: '1px solid #e5e7eb', borderRadius: '20px', fontSize: '0.8rem', cursor: 'pointer', background: '#fff', color: '#6b7280' } as const,
  pillActive: { background: '#111827', color: '#fff', borderColor: '#111827' } as const,

  section: { marginBottom: '2rem' } as const,
  sectionTitle: { fontSize: '0.75rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.06em', margin: '0 0 0.75rem', display: 'flex', alignItems: 'baseline', gap: '0.25rem' } as const,
  staleHint: { fontWeight: 400, color: '#9ca3af', textTransform: 'none' as const, letterSpacing: 0 } as const,

  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem' },
  th: { textAlign: 'left' as const, padding: '0.5rem 0.75rem', borderBottom: '1px solid #e5e7eb', fontSize: '0.7rem', color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  td: { padding: '0.65rem 0.75rem', borderBottom: '1px solid #f3f4f6', color: '#374151', verticalAlign: 'top' as const },

  ipLink: { textDecoration: 'none' } as const,
  ip: { fontFamily: 'monospace', fontSize: '0.8rem', color: '#111827' } as const,
  sub: { fontSize: '0.75rem', color: '#9ca3af', marginTop: '0.15rem' } as const,
  failBadge: { display: 'inline-block', background: '#fee2e2', color: '#dc2626', fontSize: '0.7rem', fontWeight: 600, padding: '0.15rem 0.45rem', borderRadius: '4px' } as const,
  dateCell: { fontSize: '0.8rem', color: '#6b7280', fontFamily: 'monospace' } as const,

  emptyState: { textAlign: 'center' as const, padding: '3rem 1rem' },
  emptyIcon: { fontSize: '2rem', color: '#16a34a', marginBottom: '0.75rem' },
  emptyTitle: { fontWeight: 600, color: '#111827', marginBottom: '0.4rem' } as const,
  emptyHint: { fontSize: '0.875rem', color: '#9ca3af' } as const,

  card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '0.75rem 1rem' } as const,
  muted: { color: '#9ca3af' } as const,
};
