import { useEffect, useState } from 'preact/hooks';
import { getDomains, getDomainStats, getDomainSources } from '../api';
import type { Domain, DomainStats, FailingSource } from '../types';

interface Props {
  id: number;
  onUnauthorized: () => void;
}

const POLICY_COLOR: Record<string, string> = {
  reject: '#16a34a',
  quarantine: '#d97706',
  none: '#dc2626',
};

// ── Guidance ─────────────────────────────────────────────────

interface Guidance {
  color: string;
  title: string;
  body: string;
  action?: { label: string; dns: string };
}

function getGuidance(domain: Domain, passRate: number | null, hasData: boolean): Guidance {
  const policy = domain.dmarc_policy ?? 'none';

  if (!hasData) return {
    color: '#6b7280',
    title: 'No reports yet',
    body: 'No DMARC reports have been received. Check that your DNS record includes the correct rua= address.',
    action: {
      label: 'Your DMARC record should include:',
      dns: `rua=mailto:${domain.rua_address}`,
    },
  };

  if (policy === 'none') return {
    color: '#d97706',
    title: 'Monitoring only — not enforcing',
    body: `You're observing mail flows but DMARC is not protecting your domain yet. Once your pass rate stays above 95% for a few days, switch to quarantine.`,
    action: {
      label: 'Next step — update your DMARC record:',
      dns: `v=DMARC1; p=quarantine; rua=mailto:${domain.rua_address}`,
    },
  };

  if (policy === 'quarantine') {
    if (passRate !== null && passRate >= 90) return {
      color: '#2563eb',
      title: 'Ready to enforce',
      body: `Pass rate is ${passRate}% — your legitimate mail is well-aligned. You can safely move to reject to stop spoofed mail from reaching inboxes.`,
      action: {
        label: 'Next step — update your DMARC record:',
        dns: `v=DMARC1; p=reject; rua=mailto:${domain.rua_address}`,
      },
    };
    return {
      color: '#d97706',
      title: 'Not ready for reject yet',
      body: `Pass rate is ${passRate ?? '—'}% — some legitimate mail is failing DMARC. Investigate the failing sources below before tightening your policy.`,
    };
  }

  if (policy === 'reject') {
    if (passRate !== null && passRate < 70) return {
      color: '#dc2626',
      title: 'Legitimate mail may be blocked',
      body: `Pass rate is ${passRate}% under a reject policy — some of your own mail is likely being rejected by recipients. Check the failing sources below urgently.`,
    };
    return {
      color: '#16a34a',
      title: 'Fully protected',
      body: `DMARC is enforced at reject. Pass rate is ${passRate ?? '—'}%. Spoofed mail claiming to be from ${domain.domain} is rejected by receiving servers.`,
    };
  }

  return { color: '#6b7280', title: 'Unknown policy', body: 'Could not determine guidance for the current policy.' };
}

// ── Component ─────────────────────────────────────────────────

export function DomainDetail({ id, onUnauthorized }: Props) {
  const [domain, setDomain] = useState<Domain | null>(null);
  const [stats, setStats] = useState<DomainStats | null>(null);
  const [sources, setSources] = useState<FailingSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [{ domains }, s, src] = await Promise.all([
          getDomains(),
          getDomainStats(id, 7),
          getDomainSources(id, 7),
        ]);
        if (cancelled) return;
        setDomain(domains.find((d) => d.id === id) ?? null);
        setStats(s);
        setSources(src.sources);
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
  }, [id]);

  if (loading) return <p style={s.muted}>Loading…</p>;
  if (error) return <p style={{ color: '#dc2626' }}>Error: {error}</p>;
  if (!domain || !stats) return <p style={s.muted}>Domain not found.</p>;

  const total = stats.stats.reduce((n, r) => n + r.total, 0);
  const passed = stats.stats.reduce((n, r) => n + r.passed, 0);
  const failed = stats.stats.reduce((n, r) => n + r.failed, 0);
  const passRate = total > 0 ? Math.round((passed / total) * 100) : null;
  const maxTotal = Math.max(...stats.stats.map((r) => r.total), 1);
  const policy = domain.dmarc_policy ?? 'none';

  const guidance = getGuidance(domain, passRate, total > 0);

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <a href="#/" style={s.back}>← All domains</a>

      <div style={s.header}>
        <h2 style={s.domainName}>{domain.domain}</h2>
        <span style={{ ...s.badge, color: POLICY_COLOR[policy] ?? '#6b7280' }}>{policy}</span>
      </div>

      {/* Summary numbers */}
      <div style={s.summaryRow}>
        <Stat label="Pass rate" value={passRate !== null ? `${passRate}%` : '—'} accent />
        <Stat label="Total messages" value={total.toLocaleString()} />
        <Stat label="Passed" value={passed.toLocaleString()} />
        <Stat label="Failed" value={failed.toLocaleString()} />
      </div>

      {/* Guidance */}
      <div style={{ ...s.guidanceCard, borderLeftColor: guidance.color }}>
        <div style={{ ...s.guidanceTitle, color: guidance.color }}>{guidance.title}</div>
        <p style={s.guidanceBody}>{guidance.body}</p>
        {guidance.action && (
          <div style={s.guidanceAction}>
            <span style={s.guidanceActionLabel}>{guidance.action.label}</span>
            <div style={s.dnsRow}>
              <code style={s.dnsCode}>{guidance.action.dns}</code>
              <button style={s.copyBtn} onClick={() => copy(guidance.action!.dns)}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Daily bars */}
      <h3 style={s.sectionTitle}>Last 7 days</h3>
      {stats.stats.length === 0 && <p style={s.muted}>No data yet.</p>}
      <div style={{ ...s.bars, marginBottom: '2rem' }}>
        {stats.stats.map((row) => {
          const passW = (row.passed / maxTotal) * 100;
          const failW = (row.failed / maxTotal) * 100;
          return (
            <div key={row.day} style={s.barRow}>
              <span style={s.dayLabel}>{row.day.slice(5)}</span>
              <div style={s.barTrack}>
                <div style={{ ...s.barPass, width: `${passW}%` }} />
                <div style={{ ...s.barFail, width: `${failW}%` }} />
              </div>
              <span style={s.barCount}>{row.total.toLocaleString()}</span>
            </div>
          );
        })}
      </div>

      {/* RUA config */}
      <div style={s.ruaBox}>
        <div style={s.ruaLabel}>RUA reporting address</div>
        <div style={s.dnsRow}>
          <code style={s.dnsCode}>rua=mailto:{domain.rua_address}</code>
          <button style={s.copyBtn} onClick={() => copy(`rua=mailto:${domain.rua_address}`)}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p style={s.ruaHint}>
          Add this to your <code style={s.inlineCode}>_dmarc.{domain.domain}</code> TXT record so receiving servers send DMARC reports here.
        </p>
      </div>

      {/* Failing sources */}
      {sources.length > 0 && (
        <div>
          <h3 style={s.sectionTitle}>Top failing sources</h3>
          <table style={s.table}>
            <thead>
              <tr>
                {['IP', 'Sending as', 'Failed messages'].map((h) => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.map((src) => (
                <tr key={src.source_ip}>
                  <td style={s.td}><code style={s.code}>{src.source_ip}</code></td>
                  <td style={s.td}>{src.header_from ?? <span style={s.muted}>—</span>}</td>
                  <td style={{ ...s.td, textAlign: 'right' }}>{src.total.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={s.stat}>
      <div style={{ ...s.statValue, color: accent ? '#111827' : '#374151' }}>{value}</div>
      <div style={s.statLabel}>{label}</div>
    </div>
  );
}

const s = {
  back: { fontSize: '0.875rem', color: '#6b7280', textDecoration: 'none', display: 'inline-block', marginBottom: '1.25rem' } as const,
  header: { display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '1.5rem' } as const,
  domainName: { margin: 0, fontSize: '1.5rem', fontWeight: 700 },
  badge: { fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  summaryRow: { display: 'flex', gap: '2rem', padding: '1.25rem 0', borderTop: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', marginBottom: '2rem' } as const,
  stat: { display: 'flex', flexDirection: 'column' as const, gap: '0.25rem' },
  statValue: { fontSize: '1.5rem', fontWeight: 700 },
  statLabel: { fontSize: '0.75rem', color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },

  guidanceCard: {
    borderLeft: '3px solid',
    padding: '1rem 1.25rem',
    background: '#f9fafb',
    borderRadius: '0 6px 6px 0',
    marginBottom: '2rem',
  } as const,
  guidanceTitle: { fontWeight: 600, marginBottom: '0.4rem', fontSize: '0.95rem' } as const,
  guidanceBody: { margin: '0 0 0.75rem', color: '#374151', fontSize: '0.9rem', lineHeight: 1.6 } as const,
  guidanceAction: { display: 'flex', flexDirection: 'column' as const, gap: '0.4rem' },
  guidanceActionLabel: { fontSize: '0.8rem', color: '#6b7280' } as const,
  dnsRow: { display: 'flex', alignItems: 'center', gap: '0.5rem' } as const,
  dnsCode: {
    flex: 1,
    padding: '0.4rem 0.6rem',
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: '4px',
    fontSize: '0.8rem',
    fontFamily: 'monospace',
    overflowX: 'auto' as const,
    whiteSpace: 'nowrap' as const,
  },
  copyBtn: {
    padding: '0.35rem 0.75rem',
    background: '#111827',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    fontSize: '0.8rem',
    cursor: 'pointer',
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
  },

  sectionTitle: { fontSize: '0.875rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.05em', margin: '0 0 1rem' },
  bars: { display: 'flex', flexDirection: 'column' as const, gap: '0.5rem' },
  barRow: { display: 'flex', alignItems: 'center', gap: '0.75rem' } as const,
  dayLabel: { width: '3rem', fontSize: '0.8rem', color: '#6b7280', flexShrink: 0 } as const,
  barTrack: { flex: 1, height: '8px', borderRadius: '4px', background: '#f3f4f6', overflow: 'hidden', display: 'flex' } as const,
  barPass: { height: '100%', background: '#16a34a', transition: 'width 0.3s' } as const,
  barFail: { height: '100%', background: '#dc2626', transition: 'width 0.3s' } as const,
  barCount: { width: '4rem', fontSize: '0.8rem', color: '#9ca3af', textAlign: 'right' as const, flexShrink: 0 },
  ruaBox: { padding: '1rem 1.25rem', border: '1px solid #e5e7eb', borderRadius: '6px', marginBottom: '2rem' } as const,
  ruaLabel: { fontSize: '0.75rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: '0.5rem' },
  ruaHint: { margin: '0.5rem 0 0', fontSize: '0.8rem', color: '#9ca3af', lineHeight: 1.5 } as const,
  inlineCode: { fontFamily: 'monospace', fontSize: '0.8rem', color: '#374151' } as const,
  muted: { color: '#9ca3af' } as const,
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem' },
  th: { textAlign: 'left' as const, padding: '0.5rem 0.75rem', borderBottom: '1px solid #e5e7eb', fontSize: '0.75rem', color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  td: { padding: '0.6rem 0.75rem', borderBottom: '1px solid #f3f4f6', color: '#374151' } as const,
  code: { fontFamily: 'monospace', fontSize: '0.8rem', color: '#111827' } as const,
};
