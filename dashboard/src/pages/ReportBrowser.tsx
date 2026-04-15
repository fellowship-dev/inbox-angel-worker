import { useEffect, useState } from 'preact/hooks';
import { getReports } from '../api';
import type { AggregateReport } from '../types';
import { formatDate, relativeTime } from '../utils/dates';

interface Props {
  domainId: number;
  onUnauthorized: () => void;
}

/** ISO date key for routing (YYYY-MM-DD) — separate from display format */
function toIsoDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function ReportBrowser({ domainId, onUnauthorized }: Props) {
  const [reports, setReports] = useState<AggregateReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getReports(200)
      .then(({ reports: all }) => {
        if (cancelled) return;
        setReports(all);
        // Auto-select the only domain if there's just one
        const names = Array.from(new Set(all.map(r => r.domain)));
        if (names.length === 1) setSelectedDomain(names[0]);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e.message === '401') { onUnauthorized(); return; }
        setError(e.message ?? 'Failed to load');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [domainId]);

  const domains = Array.from(new Set(reports.map(r => r.domain))).sort();
  const visible = selectedDomain ? reports.filter(r => r.domain === selectedDomain) : reports;

  return (
    <div>
      <a href={`#/domains/${domainId}`} style={s.back}>← Back</a>

      <div style={s.pageHeader}>
        <h2 style={s.title}>Reports</h2>
        {!loading && <span style={s.count}>{visible.length} report{visible.length !== 1 ? 's' : ''}</span>}
      </div>

      {loading && <p style={s.muted}>Loading…</p>}
      {error && <p style={{ color: '#dc2626' }}>Error: {error}</p>}

      {!loading && !error && domains.length > 1 && (
        <div style={s.pills}>
          <button
            style={{ ...s.pill, ...(selectedDomain === null ? s.pillActive : {}) }}
            onClick={() => setSelectedDomain(null)}
          >
            All
          </button>
          {domains.map(d => (
            <button
              key={d}
              style={{ ...s.pill, ...(selectedDomain === d ? s.pillActive : {}) }}
              onClick={() => setSelectedDomain(d)}
            >
              {d}
            </button>
          ))}
        </div>
      )}

      {!loading && !error && visible.length === 0 && (
        <p style={s.muted}>No reports yet. DMARC reports arrive daily from mail providers.</p>
      )}

      {!loading && !error && visible.length > 0 && (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Date</th>
              {domains.length > 1 && <th style={s.th}>Domain</th>}
              <th style={s.th}>Reporter</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Pass</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Fail</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const date = toIsoDate(r.date_begin);
              const passRate = r.total_count > 0 ? Math.round((r.pass_count / r.total_count) * 100) : null;
              const rateColor = passRate === null ? '#9ca3af'
                : passRate >= 95 ? '#16a34a'
                : passRate >= 70 ? '#d97706'
                : '#dc2626';
              return (
                <tr key={r.id}>
                  <td style={s.td}>
                    <a href={`#/domains/${domainId}/reports/${date}`} style={s.dateLink}>
                      {formatDate(r.date_begin)}
                      <span style={{ display: 'block', fontSize: '0.72rem', color: '#9ca3af', fontFamily: 'inherit', fontWeight: 400 }}>
                        {relativeTime(r.date_begin)}
                      </span>
                    </a>
                  </td>
                  {domains.length > 1 && <td style={{ ...s.td, color: '#6b7280' }}>{r.domain}</td>}
                  <td style={s.td}>{r.org_name}</td>
                  <td style={{ ...s.td, textAlign: 'right', color: '#16a34a', fontVariantNumeric: 'tabular-nums' }}>
                    {r.pass_count.toLocaleString()}
                  </td>
                  <td style={{ ...s.td, textAlign: 'right', color: r.fail_count > 0 ? '#dc2626' : '#9ca3af', fontVariantNumeric: 'tabular-nums' }}>
                    {r.fail_count.toLocaleString()}
                  </td>
                  <td style={{ ...s.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: rateColor, fontWeight: 600 }}>
                      {passRate !== null ? `${passRate}%` : '—'}
                    </span>
                    <span style={{ color: '#9ca3af', fontSize: '0.75rem', marginLeft: '0.35rem' }}>
                      {r.total_count.toLocaleString()}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const s = {
  back: { fontSize: '0.875rem', color: '#6b7280', textDecoration: 'none', display: 'inline-block', marginBottom: '1.5rem' } as const,
  pageHeader: { display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '1.25rem' } as const,
  title: { margin: 0, fontSize: '1.5rem', fontWeight: 700 } as const,
  count: { fontSize: '0.875rem', color: '#9ca3af' } as const,
  pills: { display: 'flex', gap: '0.35rem', marginBottom: '1.25rem', flexWrap: 'wrap' as const },
  pill: { padding: '0.25rem 0.7rem', border: '1px solid #e5e7eb', borderRadius: '20px', fontSize: '0.8rem', cursor: 'pointer', background: '#fff', color: '#6b7280' } as const,
  pillActive: { background: '#111827', color: '#fff', borderColor: '#111827' } as const,
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem' },
  th: { textAlign: 'left' as const, padding: '0.5rem 0.75rem', borderBottom: '1px solid #e5e7eb', fontSize: '0.7rem', color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  td: { padding: '0.6rem 0.75rem', borderBottom: '1px solid #f3f4f6', color: '#374151', verticalAlign: 'middle' as const },
  dateLink: { fontFamily: 'monospace', fontSize: '0.85rem', color: '#2563eb', textDecoration: 'none', fontWeight: 500 } as const,
  muted: { color: '#9ca3af' } as const,
};
