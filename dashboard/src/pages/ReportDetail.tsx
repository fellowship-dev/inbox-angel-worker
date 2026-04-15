import { useEffect, useState } from 'preact/hooks';
import { getDomainReport } from '../api';
import type { DayReport, ReportSource } from '../types';
import { useIsMobile } from '../hooks';
import { formatDateWithRelative } from '../utils/dates';

interface Props {
  domainId: number;
  date: string;
  onUnauthorized: () => void;
}

function serviceVia(src: ReportSource): string | null {
  const auth = src.spf_domain || src.dkim_domain;
  if (!auth || auth === src.header_from) return null;
  return auth;
}

function explain(src: ReportSource): string {
  const from = src.header_from ? `"${src.header_from}"` : 'your domain';
  const via = serviceVia(src);
  const service = via ? `${via}` : 'this server';

  if (!src.spf_pass && !src.dkim_pass) {
    return `${service} has no authorization to send as ${from}. ` +
      `If you don't recognize it, it's likely spoofed mail — your DMARC policy will handle it. ` +
      `If it's a service you added recently, you'll need to configure both SPF and DKIM for it.`;
  }
  if (!src.spf_pass) {
    const fix = src.spf_domain ? `Add include:${src.spf_domain} to your SPF record.` : 'Add this server to your SPF record.';
    return `${service} isn't listed in your SPF record but is sending as ${from}. ` +
      `If this is a service you use (e.g. a newsletter tool or CRM), authorize it. ${fix}`;
  }
  return `${service} sent mail without a valid DKIM signature for ${from}. ` +
    `SPF is passing, but DKIM isn't — configure DKIM signing for this service to fully protect your domain.`;
}

export function ReportDetail({ domainId, date, onUnauthorized }: Props) {
  const [report, setReport] = useState<DayReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const mobile = useIsMobile();

  function toggleExpand(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    getDomainReport(domainId, date)
      .then((r) => { if (!cancelled) setReport(r); })
      .catch((e) => {
        if (cancelled) return;
        if (e.message === '401') { onUnauthorized(); return; }
        setError(e.message ?? 'Failed to load');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [domainId, date]);

  if (loading) return <p style={s.muted}>Loading…</p>;
  if (error) return <p style={{ color: '#dc2626' }}>Error: {error}</p>;
  if (!report) return null;

  const { domain, summary, sources } = report;
  const failing = sources.filter((src) => !src.spf_pass || !src.dkim_pass);
  const passing = sources.filter((src) => src.spf_pass && src.dkim_pass);

  let hero: string;
  if (summary.total === 0) {
    hero = 'No reports received for this date.';
  } else if (failing.length === 0) {
    hero = `${summary.total.toLocaleString()} messages analyzed — everything passed.`;
  } else {
    hero = `${summary.total.toLocaleString()} messages analyzed — ${summary.failed.toLocaleString()} need attention.`;
  }

  return (
    <div>
      <a href={`#/domains/${domainId}`} style={s.back}>← {domain}</a>

      <div style={s.pageHeader}>
        <h2 style={s.title}>{formatDateWithRelative(date)}</h2>
        <p style={{ ...s.hero, color: failing.length > 0 ? '#dc2626' : '#16a34a' }}>{hero}</p>
      </div>

      {/* Summary numbers — stack on mobile */}
      {summary.total > 0 && (
        <div style={{ ...s.summaryRow, flexDirection: mobile ? 'column' : 'row', gap: mobile ? '0' : '2rem' }}>
          <Stat label="Pass rate" value={`${Math.round((summary.passed / summary.total) * 100)}%`} accent={failing.length === 0} mobile={mobile} />
          <Stat label="Total" value={summary.total.toLocaleString()} mobile={mobile} />
          <Stat label="Passed" value={summary.passed.toLocaleString()} mobile={mobile} />
          {summary.failed > 0 && <Stat label="Failed" value={summary.failed.toLocaleString()} danger mobile={mobile} />}
        </div>
      )}

      {/* Failing source cards */}
      {failing.length > 0 && (
        <section style={s.section}>
          <h3 style={s.sectionTitle}>Needs attention</h3>
          <div style={s.cardList}>
            {failing.map((src) => {
              const via = serviceVia(src);
              return (
                <div key={`${src.source_ip}-${src.header_from}`} style={s.failCard}>
                  <div style={{ ...s.cardTop, flexWrap: 'wrap' }}>
                    <div style={s.cardLeft}>
                      {(src.org || src.base_domain)
                        ? <span style={s.providerName}>{src.org ?? src.base_domain}</span>
                        : <code style={s.ip}>{src.source_ip}</code>
                      }
                      {(src.org || src.base_domain) && <code style={s.ipSub}>{src.source_ip}</code>}
                      {via && <span style={s.via}>via {via}</span>}
                      {src.header_from && <span style={s.sendingAs}>sending as {src.header_from}</span>}
                    </div>
                    <div style={s.cardRight}>
                      <span style={s.msgCount}>{src.count.toLocaleString()}</span>
                      <span style={s.msgLabel}>msg</span>
                    </div>
                  </div>
                  <p style={s.cardExplain}>{explain(src)}</p>
                  <div style={s.cardMeta}>
                    <span style={s.spfBadge(!!src.spf_pass)}>SPF {src.spf_pass ? '✓' : '✗'}</span>
                    <span style={s.dkimBadge(!!src.dkim_pass)}>DKIM {src.dkim_pass ? '✓' : '✗'}</span>
                    {src.reporters && <span style={s.reporters}>Reported by {src.reporters}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Passing sources */}
      {passing.length > 0 && (
        <section style={s.section}>
          <h3 style={s.sectionTitle}>Passing sources</h3>
          <div style={s.passList}>
            {passing.map((src) => {
              const via = serviceVia(src);
              const rowKey = `${src.source_ip}-${src.header_from}`;
              const isExpanded = expanded.has(rowKey);
              return (
                <div key={rowKey}>
                  <div
                    style={{ ...s.passRow, cursor: 'pointer' }}
                    onClick={() => toggleExpand(rowKey)}
                  >
                    <span style={s.passCheck}>✓</span>
                    <div style={{ ...s.passInfo, flexWrap: 'wrap' }}>
                      {(src.org || src.base_domain)
                        ? <span style={s.providerName}>{src.org ?? src.base_domain}</span>
                        : <code style={s.ip}>{src.source_ip}</code>
                      }
                      {(src.org || src.base_domain) && <code style={s.ipSub}>{src.source_ip}</code>}
                      {via && <span style={s.via}>via {via}</span>}
                    </div>
                    <span style={s.passCount}>{src.count.toLocaleString()} msg</span>
                    <span style={s.expandToggle}>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                  {isExpanded && (
                    <div style={s.expandPanel}>
                      <div style={s.expandGrid}>
                        <span style={s.expandLabel}>SPF</span>
                        <span style={s.spfBadge(!!src.spf_pass)}>SPF {src.spf_pass ? '✓ pass' : '✗ fail'}</span>
                        <span style={s.expandLabel}>DKIM</span>
                        <span style={s.dkimBadge(!!src.dkim_pass)}>DKIM {src.dkim_pass ? '✓ pass' : '✗ fail'}</span>
                        {src.spf_domain && <><span style={s.expandLabel}>SPF domain</span><code style={s.expandValue}>{src.spf_domain}</code></>}
                        {src.dkim_domain && <><span style={s.expandLabel}>DKIM domain</span><code style={s.expandValue}>{src.dkim_domain}</code></>}
                        {src.header_from && <><span style={s.expandLabel}>Sending as</span><code style={s.expandValue}>{src.header_from}</code></>}
                        <span style={s.expandLabel}>Messages</span><span style={s.expandValue}>{src.count.toLocaleString()}</span>
                        {src.reporters && <><span style={s.expandLabel}>Reported by</span><span style={s.expandValue}>{src.reporters}</span></>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, accent, danger, mobile }: { label: string; value: string; accent?: boolean; danger?: boolean; mobile?: boolean }) {
  const color = danger ? '#dc2626' : accent ? '#16a34a' : '#111827';
  return (
    <div style={{
      ...s.stat,
      ...(mobile ? { flexDirection: 'row' as const, justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '1px solid #f3f4f6', padding: '0.6rem 0' } : {}),
    }}>
      <div style={{ ...s.statLabel, ...(mobile ? { order: 1 } : {}) }}>{label}</div>
      <div style={{ ...s.statValue, color, ...(mobile ? { fontSize: '1.1rem', order: 2 } : {}) }}>{value}</div>
    </div>
  );
}

const s = {
  back: { fontSize: '0.875rem', color: '#6b7280', textDecoration: 'none', display: 'inline-block', marginBottom: '1.5rem' } as const,
  pageHeader: { marginBottom: '1.5rem' },
  title: { margin: '0 0 0.4rem', fontSize: '1.5rem', fontWeight: 700 },
  hero: { margin: 0, fontSize: '1rem', fontWeight: 500 } as const,
  summaryRow: { display: 'flex', padding: '1.25rem 0', borderTop: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', marginBottom: '2rem' } as const,
  stat: { display: 'flex', flexDirection: 'column' as const, gap: '0.2rem' },
  statValue: { fontSize: '1.4rem', fontWeight: 700 },
  statLabel: { fontSize: '0.7rem', color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  section: { marginBottom: '2rem' },
  sectionTitle: { fontSize: '0.75rem', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '0.06em', margin: '0 0 0.75rem' },
  cardList: { display: 'flex', flexDirection: 'column' as const, gap: '0.75rem' },
  failCard: { border: '1px solid #fca5a5', borderLeft: '3px solid #dc2626', borderRadius: '6px', padding: '1rem 1.1rem', background: '#fff' } as const,
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.6rem', gap: '0.5rem' } as const,
  cardLeft: { display: 'flex', flexDirection: 'column' as const, gap: '0.2rem' },
  cardRight: { display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-end', flexShrink: 0 },
  ip: { fontFamily: 'monospace', fontSize: '0.875rem', color: '#111827' } as const,
  providerName: { fontSize: '0.9rem', fontWeight: 600, color: '#111827' } as const,
  ipSub: { fontFamily: 'monospace', fontSize: '0.75rem', color: '#9ca3af' } as const,
  via: { fontSize: '0.75rem', color: '#6b7280' } as const,
  sendingAs: { fontSize: '0.75rem', color: '#9ca3af' } as const,
  msgCount: { fontSize: '1.25rem', fontWeight: 700, color: '#111827', lineHeight: 1 } as const,
  msgLabel: { fontSize: '0.7rem', color: '#9ca3af' } as const,
  cardExplain: { margin: '0 0 0.75rem', fontSize: '0.85rem', color: '#374151', lineHeight: 1.6 } as const,
  cardMeta: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' as const },
  spfBadge: (pass: boolean) => ({ fontSize: '0.7rem', fontWeight: 600, padding: '0.1rem 0.45rem', borderRadius: '4px', background: pass ? '#dcfce7' : '#fee2e2', color: pass ? '#16a34a' : '#dc2626' }),
  dkimBadge: (pass: boolean) => ({ fontSize: '0.7rem', fontWeight: 600, padding: '0.1rem 0.45rem', borderRadius: '4px', background: pass ? '#dcfce7' : '#fee2e2', color: pass ? '#16a34a' : '#dc2626' }),
  reporters: { fontSize: '0.75rem', color: '#9ca3af', marginLeft: 'auto' } as const,
  passList: { display: 'flex', flexDirection: 'column' as const, gap: '0' },
  passRow: { display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0', borderBottom: '1px solid #f3f4f6' } as const,
  passCheck: { color: '#16a34a', fontWeight: 700, fontSize: '0.875rem', flexShrink: 0 } as const,
  passInfo: { display: 'flex', alignItems: 'baseline', gap: '0.5rem', flex: 1 } as const,
  passCount: { fontSize: '0.8rem', color: '#9ca3af', flexShrink: 0 } as const,
  expandToggle: { fontSize: '0.6rem', color: '#d1d5db', flexShrink: 0, paddingLeft: '0.25rem' } as const,
  expandPanel: { padding: '0.6rem 0.75rem 0.75rem 2.25rem', borderBottom: '1px solid #f3f4f6', background: '#f9fafb' } as const,
  expandGrid: { display: 'grid', gridTemplateColumns: '7rem 1fr', gap: '0.3rem 0.5rem', fontSize: '0.78rem', alignItems: 'center' } as const,
  expandLabel: { color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase' as const, fontSize: '0.68rem', letterSpacing: '0.04em' } as const,
  expandValue: { fontFamily: 'monospace', fontSize: '0.78rem', color: '#374151' } as const,
  muted: { color: '#9ca3af' } as const,
};
