import { useEffect, useState } from 'preact/hooks';
import { getDomains, getDomainStats, getDomainSources, checkDomainDns, updateDmarcPolicy, getSpfFlattenStatus, enableSpfFlatten, disableSpfFlatten, getMtaStsStatus, enableMtaSts, updateMtaStsMode, refreshMtaStsMx, disableMtaSts } from '../api';
import type { Domain, DomainStats, FailingSource, SpfFlatStatus, MtaStsStatus } from '../types';
import { useIsMobile } from '../hooks';

interface Props {
  id: number;
  onUnauthorized: () => void;
}

const POLICY_COLOR: Record<string, string> = {
  reject: '#16a34a',
  quarantine: '#d97706',
  none: '#dc2626',
};

interface Guidance {
  color: string;
  title: string;
  body: string;
  action?: { label: string; dns: string; targetPolicy: string };
}

/**
 * Build a recommended DMARC record that preserves existing tags (other rua= addresses,
 * pct=, sp=, fo=, etc.) and just updates p= + appends our rua if not already present.
 */
function buildRecommendedRecord(currentRecord: string | null, targetPolicy: string, ruaAddress: string): string {
  if (!currentRecord) {
    return `v=DMARC1; p=${targetPolicy}; rua=mailto:${ruaAddress}`;
  }
  let record = /p=[a-z]+/.test(currentRecord)
    ? currentRecord.replace(/p=[a-z]+/, `p=${targetPolicy}`)
    : `${currentRecord}; p=${targetPolicy}`;
  if (!record.includes(ruaAddress)) {
    record = /rua=/.test(record)
      ? record.replace(/rua=([^;]+)/, `rua=$1,mailto:${ruaAddress}`)
      : `${record}; rua=mailto:${ruaAddress}`;
  }
  return record;
}

function getGuidance(domain: Domain, passRate: number | null, hasData: boolean, currentRecord: string | null): Guidance {
  const policy = domain.dmarc_policy ?? 'none';

  if (!hasData) return {
    color: '#6b7280',
    title: 'Waiting for first reports',
    body: 'No DMARC reports yet. Mail servers worldwide collect them throughout the day and send a batch once every 24 hours — so your first report usually arrives within a day of adding your DNS record. Nothing to do but wait.',
    action: { label: 'Double-check your DNS record includes this rua= address:', dns: `rua=mailto:${domain.rua_address}`, targetPolicy: '' },
  };

  if (policy === 'none') return {
    color: '#d97706',
    title: 'Monitoring only — not enforcing',
    body: `You're observing mail flows but DMARC is not protecting your domain yet. Once your pass rate stays above 95% for a few days, switch to quarantine.`,
    action: { label: 'Next step — update your DMARC record:', dns: buildRecommendedRecord(currentRecord, 'quarantine', domain.rua_address), targetPolicy: 'quarantine' },
  };

  if (policy === 'quarantine') {
    if (passRate !== null && passRate >= 90) return {
      color: '#2563eb',
      title: 'Ready to enforce',
      body: `Pass rate is ${passRate}% — your legitimate mail is well-aligned. You can safely move to reject to stop spoofed mail from reaching inboxes.`,
      action: { label: 'Next step — update your DMARC record:', dns: buildRecommendedRecord(currentRecord, 'reject', domain.rua_address), targetPolicy: 'reject' },
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

const CHART_WINDOWS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '60d', days: 60 },
];

export function DomainDetail({ id, onUnauthorized }: Props) {
  const [domain, setDomain] = useState<Domain | null>(null);
  const [stats, setStats] = useState<DomainStats | null>(null);
  const [chartDays, setChartDays] = useState(7);
  const [sources, setSources] = useState<FailingSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [dnsOk, setDnsOk] = useState<boolean | null>(null);
  const [currentRecord, setCurrentRecord] = useState<string | null>(null);
  const [cfManaged, setCfManaged] = useState(false);
  const [dmarcBusy, setDmarcBusy] = useState(false);
  const [dmarcError, setDmarcError] = useState<string | null>(null);
  const [spfFlat, setSpfFlat] = useState<SpfFlatStatus | null>(null);
  const [spfFlatBusy, setSpfFlatBusy] = useState(false);
  const [spfFlatError, setSpfFlatError] = useState<string | null>(null);
  const [mtaSts, setMtaSts] = useState<MtaStsStatus | null>(null);
  const [mtaStsBusy, setMtaStsBusy] = useState(false);
  const [mtaStsError, setMtaStsError] = useState<string | null>(null);
  const mobile = useIsMobile();

  // Initial load: domain info + failing sources (don't depend on chartDays)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [{ domains }, src, flat, mta] = await Promise.all([
          getDomains(),
          getDomainSources(id, 7),
          getSpfFlattenStatus(id).catch(() => null),
          getMtaStsStatus(id).catch(() => null),
        ]);
        if (cancelled) return;
        setDomain(domains.find((d) => d.id === id) ?? null);
        setSources(src.sources);
        if (flat) setSpfFlat(flat);
        if (mta) setMtaSts(mta);
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

  // Chart stats — refetch when chartDays changes
  useEffect(() => {
    let cancelled = false;
    getDomainStats(id, chartDays)
      .then(st => { if (!cancelled) setStats(st); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id, chartDays]);

  const total = stats ? stats.stats.reduce((n, r) => n + r.total, 0) : 0;

  // DNS check on load — detects current record for comparison + CF-managed flag
  useEffect(() => {
    if (!stats) return;
    checkDomainDns(id)
      .then(({ found, has_rua, current_record, cf_managed }) => {
        setDnsOk(found && has_rua);
        setCurrentRecord(current_record);
        setCfManaged(cf_managed);
      })
      .catch(() => {});
  }, [id, stats]);

  if (loading) return <p style={s.muted}>Loading…</p>;
  if (error) return <p style={{ color: '#dc2626' }}>Error: {error}</p>;
  if (!domain || !stats) return <p style={s.muted}>Domain not found.</p>;

  const passed = stats.stats.reduce((n, r) => n + r.passed, 0);
  const failed = stats.stats.reduce((n, r) => n + r.failed, 0);
  const passRate = total > 0 ? Math.round((passed / total) * 100) : null;
  const maxTotal = Math.max(...stats.stats.map((r) => r.total), 1);
  const policy = domain.dmarc_policy ?? 'none';
  const guidance = getGuidance(domain, passRate, total > 0, currentRecord);

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
        <a href={`#/domains/${id}/settings`} style={s.settingsLink}>Settings</a>
      </div>

      {/* Summary numbers — 2×2 grid on mobile */}
      <div style={{ ...s.summaryRow, flexWrap: 'wrap', gap: mobile ? '1rem' : '2rem' }}>
        <Stat label="Pass rate" value={passRate !== null ? `${passRate}%` : '—'} accent mobile={mobile} />
        <Stat label="Total" value={total.toLocaleString()} mobile={mobile} />
        <Stat label="Passed" value={passed.toLocaleString()} mobile={mobile} />
        <Stat label="Failed" value={failed.toLocaleString()} mobile={mobile} />
      </div>

      {/* Guidance */}
      <div style={{ ...s.guidanceCard, borderLeftColor: guidance.color }}>
        <div style={{ ...s.guidanceTitle, color: guidance.color }}>{guidance.title}</div>
        <p style={s.guidanceBody}>{guidance.body}</p>
        {guidance.action && guidance.action.targetPolicy && (
          <div style={s.guidanceAction}>
            <span style={s.guidanceActionLabel}>{guidance.action.label}</span>
            {currentRecord && currentRecord !== guidance.action.dns && (
              <div style={{ marginBottom: '0.5rem', fontSize: '0.8rem' }}>
                <div style={{ color: '#6b7280', marginBottom: '0.2rem' }}>Current:</div>
                <code style={{ ...s.dnsCode, opacity: 0.6, textDecoration: 'line-through' }}>{currentRecord}</code>
              </div>
            )}
            <div style={{ ...s.dnsRow, flexWrap: 'wrap' }}>
              <code style={s.dnsCode}>{guidance.action.dns}</code>
              <button style={s.copyBtn} onClick={() => copy(guidance.action!.dns)}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
              {cfManaged && guidance.action.targetPolicy && (
                <button
                  style={{ ...s.copyBtn, background: guidance.color, color: '#fff', borderColor: guidance.color, opacity: dmarcBusy ? 0.6 : 1 }}
                  disabled={dmarcBusy}
                  onClick={async () => {
                    setDmarcBusy(true);
                    setDmarcError(null);
                    try {
                      await updateDmarcPolicy(id, guidance.action!.targetPolicy);
                      const { domains } = await getDomains();
                      const updated = domains.find(d => d.id === id);
                      if (updated) setDomain(updated);
                      setCurrentRecord(guidance.action!.dns);
                    } catch (e: any) {
                      setDmarcError(e.message ?? 'Failed to update DMARC policy');
                    } finally {
                      setDmarcBusy(false);
                    }
                  }}
                >
                  {dmarcBusy ? 'Applying…' : 'Apply via Cloudflare'}
                </button>
              )}
            </div>
            {dmarcError && <p style={{ color: '#dc2626', fontSize: '0.8rem', marginTop: '0.25rem' }}>{dmarcError}</p>}
          </div>
        )}
        {total === 0 && dnsOk !== null && (
          <p style={{ ...s.guidanceBody, marginTop: '0.5rem', fontStyle: 'italic' }}>
            {dnsOk
              ? '✓ DNS record detected — reports will start arriving soon.'
              : '⚠️ DNS record not found yet. Make sure you\'ve added it, then wait a few minutes for propagation.'}
          </p>
        )}
      </div>

      {/* Daily bars */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h3 style={{ ...s.sectionTitle, marginBottom: 0 }}>Last {chartDays} days</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {CHART_WINDOWS.map(w => (
              <button
                key={w.days}
                style={{ ...s.chartPill, ...(chartDays === w.days ? s.chartPillActive : {}) }}
                onClick={() => setChartDays(w.days)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <a href={`#/domains/${id}/reports`} style={s.viewAll}>All reports →</a>
        </div>
      </div>
      {stats.stats.length === 0 && <p style={s.muted}>No data yet.</p>}
      <div style={{ ...s.bars, marginBottom: '2rem' }}>
        {stats.stats.map((row) => {
          const passW = (row.passed / maxTotal) * 100;
          const failW = (row.failed / maxTotal) * 100;
          const label = chartDays <= 7 ? row.day.slice(5) : row.day.slice(5).replace('-', '/');
          return (
            <a key={row.day} href={`#/domains/${id}/reports/${row.day}`} style={s.barRow}>
              <span style={{ ...s.dayLabel, fontSize: chartDays > 7 ? '0.65rem' : undefined }}>{label}</span>
              <div style={s.barTrack}>
                <div style={{ ...s.barPass, width: `${passW}%` }} />
                <div style={{ ...s.barFail, width: `${failW}%` }} />
              </div>
              {!mobile && <span style={s.barCount}>{row.total.toLocaleString()}</span>}
            </a>
          );
        })}
      </div>

      {/* RUA config */}
      <div style={s.ruaBox}>
        <div style={s.ruaLabel}>RUA reporting address</div>
        <div style={{ ...s.dnsRow, flexWrap: 'wrap' }}>
          <code style={s.dnsCode}>rua=mailto:{domain.rua_address}</code>
          <button style={s.copyBtn} onClick={() => copy(`rua=mailto:${domain.rua_address}`)}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p style={s.ruaHint}>
          Add this to your <code style={s.inlineCode}>_dmarc.{domain.domain}</code> TXT record so receiving servers send DMARC reports here.
        </p>
      </div>

      {/* SPF health card — only shown when CF creds present or flattening already active */}
      {spfFlat && (spfFlat.available || spfFlat.config) && (
        <SpfHealthCard
          domainId={id}
          status={spfFlat}
          busy={spfFlatBusy}
          error={spfFlatError}
          onEnable={async () => {
            setSpfFlatBusy(true);
            setSpfFlatError(null);
            try {
              const { config } = await enableSpfFlatten(id);
              setSpfFlat({ available: true, config, lookup_count: spfFlat?.lookup_count ?? null });
            } catch (e: any) {
              setSpfFlatError(e.message ?? 'Failed to enable');
            } finally {
              setSpfFlatBusy(false);
            }
          }}
          onDisable={async () => {
            setSpfFlatBusy(true);
            setSpfFlatError(null);
            try {
              await disableSpfFlatten(id);
              setSpfFlat({ available: spfFlat.available, config: null, lookup_count: spfFlat?.lookup_count ?? null });
            } catch (e: any) {
              setSpfFlatError(e.message ?? 'Failed to disable');
            } finally {
              setSpfFlatBusy(false);
            }
          }}
        />
      )}

      {/* MTA-STS health card — only shown when CF creds present or MTA-STS already active */}
      {mtaSts && (mtaSts.available || mtaSts.config) && (
        <MtaStsHealthCard
          status={mtaSts}
          busy={mtaStsBusy}
          error={mtaStsError}
          onEnable={async () => {
            setMtaStsBusy(true);
            setMtaStsError(null);
            try {
              await enableMtaSts(id);
              const updated = await getMtaStsStatus(id);
              setMtaSts(updated);
            } catch (e: any) {
              setMtaStsError(e.message ?? 'Failed to enable');
            } finally {
              setMtaStsBusy(false);
            }
          }}
          onSetMode={async (mode) => {
            setMtaStsBusy(true);
            setMtaStsError(null);
            try {
              await updateMtaStsMode(id, mode);
              const updated = await getMtaStsStatus(id);
              setMtaSts(updated);
            } catch (e: any) {
              setMtaStsError(e.message ?? 'Failed to update mode');
            } finally {
              setMtaStsBusy(false);
            }
          }}
          onRefreshMx={async () => {
            setMtaStsBusy(true);
            setMtaStsError(null);
            try {
              await refreshMtaStsMx(id);
              const updated = await getMtaStsStatus(id);
              setMtaSts(updated);
            } catch (e: any) {
              setMtaStsError(e.message ?? 'Failed to refresh MX');
            } finally {
              setMtaStsBusy(false);
            }
          }}
          onDisable={async () => {
            setMtaStsBusy(true);
            setMtaStsError(null);
            try {
              await disableMtaSts(id);
              setMtaSts({ available: mtaSts.available, config: null, summary: null });
            } catch (e: any) {
              setMtaStsError(e.message ?? 'Failed to disable');
            } finally {
              setMtaStsBusy(false);
            }
          }}
        />
      )}

      {/* Failing sources */}
      {sources.length > 0 && (
        <div>
          <div style={s.sectionHeader}>
            <h3 style={s.sectionTitle}>Top failing sources</h3>
            <a href={`#/domains/${id}/anomalies`} style={{ ...s.viewAll, marginRight: '0.75rem' }}>Anomalies →</a>
            <a href={`#/domains/${id}/explore`} style={s.viewAll}>Explore sources →</a>
          </div>
          {mobile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {sources.map((src) => (
                <div key={src.source_ip} style={s.sourceCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <code style={s.code}>{src.source_ip}</code>
                    <span style={s.muted}>{src.total.toLocaleString()} msg</span>
                  </div>
                  {(src.org || src.base_domain) && <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.2rem' }}>{src.org ?? src.base_domain}</div>}
                  {src.header_from && <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.2rem' }}>{src.header_from}</div>}
                </div>
              ))}
            </div>
          ) : (
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
                    <td style={s.td}>
                      <code style={s.code}>{src.source_ip}</code>
                      {(src.org || src.base_domain) && <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>{src.org ?? src.base_domain}</div>}
                    </td>
                    <td style={s.td}>{src.header_from ?? <span style={s.muted}>—</span>}</td>
                    <td style={{ ...s.td, textAlign: 'right' }}>{src.total.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function SpfHealthCard({
  domainId, status, busy, error, onEnable, onDisable,
}: {
  domainId: number;
  status: SpfFlatStatus;
  busy: boolean;
  error: string | null;
  onEnable: () => void;
  onDisable: () => void;
}) {
  const { config } = status;
  // Use the domain-level cached count (populated on add + daily cron), fall back to config
  const lookupCount = status.lookup_count ?? config?.lookup_count ?? null;
  const isHigh = lookupCount !== null && lookupCount >= 8;
  const isOver = lookupCount !== null && lookupCount >= 10;

  const countColor = isOver ? '#b91c1c' : isHigh ? '#92400e' : '#15803d';
  const countBg   = isOver ? '#fee2e2' : isHigh ? '#fef3c7' : '#dcfce7';

  const borderColor = config
    ? '#16a34a'
    : isOver ? '#dc2626'
    : isHigh ? '#d97706'
    : '#e5e7eb';

  const lastSync = config?.last_flattened_at
    ? new Date(config.last_flattened_at * 1000).toLocaleString('en-GB', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : null;

  return (
    <div style={{
      border: '1px solid #e5e7eb',
      borderLeft: `4px solid ${borderColor}`,
      borderRadius: '8px',
      padding: '1rem 1.25rem',
      marginBottom: '2rem',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
            <span style={{ fontWeight: 700, fontSize: '0.875rem' }}>SPF lookup depth</span>
            {lookupCount !== null && (
              <span style={{
                padding: '1px 7px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 700,
                color: countColor, background: countBg,
              }}>
                {lookupCount}/10
              </span>
            )}
            {config && (
              <span style={{
                padding: '1px 7px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 700,
                color: '#15803d', background: '#dcfce7',
              }}>
                ✓ flattening active
              </span>
            )}
          </div>
          <p style={{ margin: 0, fontSize: '0.8rem', color: '#6b7280', lineHeight: 1.5 }}>
            {config
              ? `${config.ip_count ?? '?'} IPs in flattened record — lookup count reduced to 1. Re-resolved daily.${lastSync ? ` Last synced ${lastSync}.` : ''}`
              : isOver
              ? 'SPF requires more than 10 DNS lookups — receivers may return permerror and silently drop your mail. Enable flattening to resolve all includes to raw IPs.'
              : isHigh
              ? `SPF requires ${lookupCount}/10 lookups — close to the limit. Adding another mail provider could break delivery. Consider enabling flattening.`
              : lookupCount !== null
              ? `SPF requires ${lookupCount}/10 DNS lookups — within safe limits.`
              : 'SPF lookup depth not yet measured — will populate within a few seconds of domain setup.'}
          </p>
          {config?.last_error && (
            <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: '#dc2626' }}>
              Last error: {config.last_error}
            </p>
          )}
          {error && (
            <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: '#dc2626' }}>{error}</p>
          )}
          {config?.canonical_record && (
            <details style={{ marginTop: '0.5rem' }}>
              <summary style={{ fontSize: '0.75rem', color: '#9ca3af', cursor: 'pointer' }}>
                Original record
              </summary>
              <code style={{
                display: 'block', marginTop: '0.3rem', fontSize: '0.72rem',
                background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '4px',
                padding: '0.35rem 0.5rem', wordBreak: 'break-all', color: '#374151',
              }}>{config.canonical_record}</code>
            </details>
          )}
        </div>
        <div style={{ flexShrink: 0 }}>
          {config ? (
            <button
              onClick={onDisable}
              disabled={busy}
              style={{
                padding: '0.35rem 0.85rem', fontSize: '0.8rem', cursor: busy ? 'default' : 'pointer',
                background: '#fff', color: '#6b7280', border: '1px solid #d1d5db',
                borderRadius: '6px', opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? 'Working…' : 'Disable'}
            </button>
          ) : (isHigh || isOver) && (
            <button
              onClick={onEnable}
              disabled={busy}
              style={{
                padding: '0.35rem 0.85rem', fontSize: '0.8rem', cursor: busy ? 'default' : 'pointer',
                background: '#111827', color: '#fff', border: 'none',
                borderRadius: '6px', opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? 'Flattening…' : 'Enable flattening'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MtaStsHealthCard({
  status, busy, error, onEnable, onSetMode, onRefreshMx, onDisable,
}: {
  status: MtaStsStatus;
  busy: boolean;
  error: string | null;
  onEnable: () => void;
  onSetMode: (mode: 'testing' | 'enforce') => void;
  onRefreshMx: () => void;
  onDisable: () => void;
}) {
  const { config, summary } = status;
  const isActive = !!config?.enabled;
  const mode = config?.mode ?? 'testing';
  const mxHosts = config?.mx_hosts ? config.mx_hosts.split(',').filter(Boolean) : [];

  const borderColor = isActive
    ? mode === 'enforce' ? '#16a34a' : '#2563eb'
    : '#e5e7eb';

  const modeColor   = mode === 'enforce' ? '#15803d' : '#1d4ed8';
  const modeBg      = mode === 'enforce' ? '#dcfce7' : '#dbeafe';

  const updatedAt = config?.updated_at
    ? new Date(config.updated_at * 1000).toLocaleString('en-GB', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : null;

  return (
    <div style={{
      border: '1px solid #e5e7eb',
      borderLeft: `4px solid ${borderColor}`,
      borderRadius: '8px',
      padding: '1rem 1.25rem',
      marginBottom: '2rem',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: '0.875rem' }}>MTA-STS / TLS-RPT</span>
            {isActive && (
              <span style={{
                padding: '1px 7px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 700,
                color: modeColor, background: modeBg,
              }}>
                {mode}
              </span>
            )}
          </div>
          <p style={{ margin: 0, fontSize: '0.8rem', color: '#6b7280', lineHeight: 1.5 }}>
            {isActive
              ? `Protecting inbound TLS via MTA-STS (${mode} mode). ${mxHosts.length} MX host${mxHosts.length !== 1 ? 's' : ''} in policy.${updatedAt ? ` Updated ${updatedAt}.` : ''}`
              : 'Enable MTA-STS to instruct sending MTAs to enforce TLS when delivering to your domain, and collect TLS-RPT failure reports.'}
          </p>
          {isActive && summary && (
            <p style={{ margin: '0.3rem 0 0', fontSize: '0.78rem', color: '#6b7280' }}>
              Last 30 days: {summary.total_success.toLocaleString()} successful sessions,{' '}
              {summary.total_failure > 0
                ? <span style={{ color: '#dc2626', fontWeight: 600 }}>{summary.total_failure.toLocaleString()} failures</span>
                : <span style={{ color: '#15803d' }}>0 failures</span>
              }{' '}({summary.report_count} report{summary.report_count !== 1 ? 's' : ''})
            </p>
          )}
          {isActive && mxHosts.length > 0 && (
            <details style={{ marginTop: '0.5rem' }}>
              <summary style={{ fontSize: '0.75rem', color: '#9ca3af', cursor: 'pointer' }}>MX hosts in policy</summary>
              <ul style={{ margin: '0.3rem 0 0', paddingLeft: '1.25rem', fontSize: '0.72rem', color: '#374151' }}>
                {mxHosts.map(h => <li key={h}>{h}</li>)}
              </ul>
            </details>
          )}
          {config?.last_error && (
            <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: '#dc2626' }}>
              Last error: {config.last_error}
            </p>
          )}
          {error && (
            <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: '#dc2626' }}>{error}</p>
          )}
        </div>
        <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem', alignItems: 'flex-end' }}>
          {!isActive ? (
            <button
              onClick={onEnable}
              disabled={busy}
              style={{
                padding: '0.35rem 0.85rem', fontSize: '0.8rem', cursor: busy ? 'default' : 'pointer',
                background: '#111827', color: '#fff', border: 'none',
                borderRadius: '6px', opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? 'Enabling…' : 'Enable MTA-STS'}
            </button>
          ) : (
            <>
              {mode === 'testing' && (() => {
                const agedays = config?.created_at
                  ? (Date.now() / 1000 - config.created_at) / 86400
                  : 0;
                const failures = summary?.total_failure ?? 0;
                const ready = agedays >= 7 && failures === 0;
                const daysLeft = Math.ceil(7 - agedays);
                return ready ? (
                  <button
                    onClick={() => onSetMode('enforce')}
                    disabled={busy}
                    style={{
                      padding: '0.35rem 0.85rem', fontSize: '0.8rem', cursor: busy ? 'default' : 'pointer',
                      background: '#15803d', color: '#fff', border: 'none',
                      borderRadius: '6px', opacity: busy ? 0.6 : 1,
                    }}
                  >
                    {busy ? 'Working…' : 'Graduate to enforce'}
                  </button>
                ) : (
                  <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                    {failures > 0
                      ? `Fix ${failures} TLS failure${failures !== 1 ? 's' : ''} first`
                      : `Graduate available in ${daysLeft}d`}
                  </span>
                );
              })()}
              {mode === 'enforce' && (
                <button
                  onClick={() => onSetMode('testing')}
                  disabled={busy}
                  style={{
                    padding: '0.35rem 0.85rem', fontSize: '0.8rem', cursor: busy ? 'default' : 'pointer',
                    background: '#fff', color: '#1d4ed8', border: '1px solid #93c5fd',
                    borderRadius: '6px', opacity: busy ? 0.6 : 1,
                  }}
                >
                  {busy ? 'Working…' : 'Revert to testing'}
                </button>
              )}
              <button
                onClick={onRefreshMx}
                disabled={busy}
                style={{
                  padding: '0.35rem 0.85rem', fontSize: '0.8rem', cursor: busy ? 'default' : 'pointer',
                  background: '#fff', color: '#374151', border: '1px solid #d1d5db',
                  borderRadius: '6px', opacity: busy ? 0.6 : 1,
                }}
              >
                {busy ? 'Working…' : 'Refresh MX'}
              </button>
              <button
                onClick={onDisable}
                disabled={busy}
                style={{
                  padding: '0.35rem 0.85rem', fontSize: '0.8rem', cursor: busy ? 'default' : 'pointer',
                  background: '#fff', color: '#6b7280', border: '1px solid #d1d5db',
                  borderRadius: '6px', opacity: busy ? 0.6 : 1,
                }}
              >
                {busy ? 'Working…' : 'Disable'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent, mobile }: { label: string; value: string; accent?: boolean; mobile?: boolean }) {
  return (
    <div style={{ ...s.stat, minWidth: mobile ? 'calc(50% - 0.5rem)' : 'auto' }}>
      <div style={{ ...s.statValue, color: accent ? '#111827' : '#374151' }}>{value}</div>
      <div style={s.statLabel}>{label}</div>
    </div>
  );
}

const s = {
  back: { fontSize: '0.875rem', color: '#6b7280', textDecoration: 'none', display: 'inline-block', marginBottom: '1.25rem' } as const,
  header: { display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' as const },
  domainName: { margin: 0, fontSize: '1.5rem', fontWeight: 700 },
  badge: { fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  summaryRow: { display: 'flex', padding: '1.25rem 0', borderTop: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', marginBottom: '2rem' } as const,
  stat: { display: 'flex', flexDirection: 'column' as const, gap: '0.25rem' },
  statValue: { fontSize: '1.5rem', fontWeight: 700 },
  statLabel: { fontSize: '0.75rem', color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  guidanceCard: { borderLeft: '3px solid', padding: '1rem 1.25rem', background: '#f9fafb', borderRadius: '0 6px 6px 0', marginBottom: '2rem' } as const,
  guidanceTitle: { fontWeight: 600, marginBottom: '0.4rem', fontSize: '0.95rem' } as const,
  guidanceBody: { margin: '0 0 0.75rem', color: '#374151', fontSize: '0.9rem', lineHeight: 1.6 } as const,
  guidanceAction: { display: 'flex', flexDirection: 'column' as const, gap: '0.4rem' },
  guidanceActionLabel: { fontSize: '0.8rem', color: '#6b7280' } as const,
  dnsRow: { display: 'flex', alignItems: 'center', gap: '0.5rem' } as const,
  dnsCode: { flex: 1, minWidth: 0, padding: '0.4rem 0.6rem', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '4px', fontSize: '0.8rem', fontFamily: 'monospace', overflowX: 'auto' as const, whiteSpace: 'nowrap' as const },
  copyBtn: { padding: '0.35rem 0.75rem', background: '#111827', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '0.8rem', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' as const },
  sectionHeader: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '1rem' } as const,
  sectionTitle: { fontSize: '0.875rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.05em', margin: 0 },
  viewAll: { fontSize: '0.8rem', color: '#6b7280', textDecoration: 'none' } as const,
  chartPill: { padding: '0.15rem 0.5rem', border: '1px solid #e5e7eb', borderRadius: '20px', fontSize: '0.75rem', cursor: 'pointer', background: '#fff', color: '#6b7280', fontFamily: 'inherit' } as const,
  chartPillActive: { background: '#111827', color: '#fff', borderColor: '#111827' } as const,
  bars: { display: 'flex', flexDirection: 'column' as const, gap: '0.5rem' },
  barRow: { display: 'flex', alignItems: 'center', gap: '0.75rem', textDecoration: 'none', color: 'inherit', borderRadius: '4px', padding: '2px 4px', margin: '0 -4px' } as const,
  dayLabel: { width: '3rem', fontSize: '0.8rem', color: '#6b7280', flexShrink: 0 } as const,
  barTrack: { flex: 1, height: '8px', borderRadius: '4px', background: '#f3f4f6', overflow: 'hidden', display: 'flex' } as const,
  barPass: { height: '100%', background: '#16a34a', transition: 'width 0.3s' } as const,
  barFail: { height: '100%', background: '#dc2626', transition: 'width 0.3s' } as const,
  barCount: { width: '4rem', fontSize: '0.8rem', color: '#9ca3af', textAlign: 'right' as const, flexShrink: 0 },
  ruaBox: { padding: '1rem 1.25rem', border: '1px solid #e5e7eb', borderRadius: '6px', marginBottom: '2rem' } as const,
  ruaLabel: { fontSize: '0.75rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: '0.5rem' },
  ruaHint: { margin: '0.5rem 0 0', fontSize: '0.8rem', color: '#9ca3af', lineHeight: 1.5 } as const,
  inlineCode: { fontFamily: 'monospace', fontSize: '0.8rem', color: '#374151' } as const,
  muted: { color: '#9ca3af', fontSize: '0.875rem' } as const,
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem' },
  th: { textAlign: 'left' as const, padding: '0.5rem 0.75rem', borderBottom: '1px solid #e5e7eb', fontSize: '0.75rem', color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  td: { padding: '0.6rem 0.75rem', borderBottom: '1px solid #f3f4f6', color: '#374151' } as const,
  code: { fontFamily: 'monospace', fontSize: '0.8rem', color: '#111827' } as const,
  settingsLink: { marginLeft: 'auto', fontSize: '0.8rem', color: '#6b7280', textDecoration: 'none' } as const,
  sourceCard: { padding: '0.75rem', border: '1px solid #f3f4f6', borderRadius: '6px', background: '#fff' } as const,
};
