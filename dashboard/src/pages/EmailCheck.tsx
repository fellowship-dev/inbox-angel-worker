import { useState, useEffect, useRef } from 'preact/hooks';
import type { CheckResult } from '../types';
import { getCheckResults } from '../api';
import { useIsMobile } from '../hooks';

type Phase = 'idle' | 'waiting' | 'done' | 'error';

interface CheckSession {
  token: string;
  email: string;
}

interface CheckPollResponse {
  status: 'pending' | 'done';
  result?: CheckResult;
}

async function createSession(): Promise<CheckSession> {
  const res = await fetch('/api/check-sessions', { method: 'POST' });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function pollSession(token: string): Promise<CheckPollResponse> {
  const res = await fetch(`/api/check-sessions/${token}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function statusColor(s: string | null) {
  if (s === 'pass') return '#16a34a';
  if (s === 'fail') return '#dc2626';
  return '#9ca3af';
}

function PassFail({ val, label }: { val: string | null; label: string }) {
  const pass = val === 'pass';
  const missing = !val || val === 'none';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
      fontSize: '0.8rem', fontWeight: 600,
      color: missing ? '#9ca3af' : statusColor(val),
    }}>
      {missing ? '—' : pass ? '✓' : '✗'} {label}
    </span>
  );
}

function ProtocolCard({ title, result, record, domain, badge, children }: {
  title: string;
  result: string | null;
  record?: string | null;
  domain?: string | null;
  badge?: preact.VNode | null;
  children: preact.ComponentChildren;
}) {
  const pass = result === 'pass';
  const missing = !result || result === 'none';
  return (
    <div style={{
      border: '1px solid #e5e7eb',
      borderLeft: `4px solid ${missing ? '#d1d5db' : pass ? '#16a34a' : '#dc2626'}`,
      borderRadius: '8px',
      padding: '1rem 1.25rem',
      marginBottom: '0.75rem',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>{title}{badge}</span>
        <span style={{
          fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px',
          borderRadius: '9999px',
          background: missing ? '#f3f4f6' : pass ? '#dcfce7' : '#fee2e2',
          color: missing ? '#6b7280' : pass ? '#15803d' : '#b91c1c',
        }}>
          {missing ? 'not configured' : pass ? 'pass' : result ?? 'fail'}
        </span>
      </div>
      {domain && <div style={{ fontSize: '0.8rem', color: '#6b7280', marginBottom: '0.4rem' }}>domain: {domain}</div>}
      {record && (
        <code style={{
          display: 'block', fontSize: '0.75rem', background: '#f9fafb',
          border: '1px solid #e5e7eb', borderRadius: '4px',
          padding: '0.4rem 0.6rem', margin: '0.5rem 0',
          wordBreak: 'break-all', color: '#374151',
        }}>{record}</code>
      )}
      <p style={{ margin: '0.5rem 0 0', fontSize: '0.875rem', color: '#374151', lineHeight: '1.5' }}>
        {children}
      </p>
    </div>
  );
}

function spfLookupBadge(count: number | null): preact.VNode | null {
  if (count === null) return null;
  const color = count >= 10 ? '#b91c1c' : count >= 8 ? '#92400e' : '#15803d';
  const bg    = count >= 10 ? '#fee2e2' : count >= 8 ? '#fef3c7' : '#dcfce7';
  const warn  = count >= 10 ? '⚠ ' : count >= 8 ? '⚠ ' : '';
  return (
    <span style={{
      display: 'inline-block', marginLeft: '0.5rem',
      padding: '1px 7px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 700,
      color, background: bg,
    }}>
      {warn}{count}/10 lookups
    </span>
  );
}

function spfAdvice(result: string | null, record: string | null, lookupCount: number | null): string {
  if (!result || result === 'none') return 'No SPF record found. Add a TXT record to your DNS: v=spf1 include:your-mail-provider.com ~all';
  if (result === 'permerror') return `SPF permerror — your record requires ${lookupCount ?? '?'} DNS lookups, exceeding the 10-lookup limit. Receivers treat this as a fail. Flatten your SPF record or use a dynamic SPF service.`;
  if (lookupCount !== null && lookupCount >= 10) return `SPF passed this time, but your record needs ${lookupCount} DNS lookups — at or over the limit. Some receivers will return permerror and silently drop your mail. Flatten your includes or use a dynamic SPF service.`;
  if (lookupCount !== null && lookupCount >= 8) return `SPF passed. Your record uses ${lookupCount}/10 lookups — close to the limit. Adding another mail provider could break SPF delivery.`;
  if (result === 'pass') return `SPF passed — the sending server is authorized by your DNS record.${lookupCount !== null ? ` Uses ${lookupCount}/10 DNS lookups.` : ''}`;
  if (result === 'softfail') return 'SPF soft-failed (~all). Consider tightening to -all once you\'ve verified all senders.';
  if (result === 'fail') return 'SPF hard-failed. The sending server is not listed in your SPF record. Check you\'ve included all mail providers.';
  return `SPF returned "${result}". Review your SPF record for syntax errors or missing includes.`;
}

function dkimAdvice(result: string | null): string {
  if (!result || result === 'none') return 'No DKIM signature found. Configure DKIM signing in your email provider and add the public key to DNS.';
  if (result === 'pass') return 'DKIM passed — this email was cryptographically signed by your domain.';
  return 'DKIM failed. The signature didn\'t match — check your private key is correctly configured in your mail provider.';
}

function dmarcAdvice(result: string | null, policy: string | null, record: string | null): string {
  if (!record) return 'No DMARC record found. Add: _dmarc.yourdomain.com TXT "v=DMARC1; p=none; rua=mailto:rua@reports.yourdomain.com"';
  if (!result || result === 'none') return 'DMARC record exists but couldn\'t evaluate alignment. Check SPF and DKIM are passing first.';
  if (result === 'pass' && policy === 'reject') return 'DMARC passed with p=reject — maximum protection enabled.';
  if (result === 'pass' && policy === 'quarantine') return 'DMARC passed. Consider upgrading to p=reject for full protection once you\'re confident all legitimate mail passes.';
  if (result === 'pass' && policy === 'none') return 'DMARC passed but policy is p=none — you\'re in monitoring mode. Upgrade to p=quarantine then p=reject when ready.';
  if (result === 'fail') return 'DMARC failed — SPF or DKIM alignment isn\'t matching your From: domain. Check that your mail provider sends from the same domain.';
  return `DMARC result: ${result}. Policy: ${policy ?? 'none'}.`;
}

function overallBadge(status: string): { text: string; color: string; bg: string } {
  if (status === 'protected') return { text: '✓ Protected', color: '#15803d', bg: '#dcfce7' };
  if (status === 'at_risk')   return { text: '⚠ At risk',   color: '#92400e', bg: '#fef3c7' };
  return                             { text: '✗ Exposed',   color: '#b91c1c', bg: '#fee2e2' };
}

function CheckReport({ result, onReset }: { result: CheckResult; onReset: () => void }) {
  const badge = overallBadge(result.overall_status);
  const ts = new Date(result.created_at * 1000).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <h2 style={{ margin: '0 0 0.25rem', fontSize: '1.1rem' }}>{result.from_domain}</h2>
          <div style={{ fontSize: '0.8rem', color: '#6b7280' }}>
            sent from {result.from_email} · {ts}
          </div>
        </div>
        <span style={{
          padding: '4px 12px', borderRadius: '9999px', fontSize: '0.8rem', fontWeight: 700,
          color: badge.color, background: badge.bg,
        }}>{badge.text}</span>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <PassFail val={result.spf_result} label="SPF" />
        <span style={{ color: '#d1d5db' }}>·</span>
        <PassFail val={result.dkim_result} label="DKIM" />
        <span style={{ color: '#d1d5db' }}>·</span>
        <PassFail val={result.dmarc_result} label="DMARC" />
      </div>

      <ProtocolCard title="SPF" result={result.spf_result} record={result.spf_record} domain={result.spf_domain} badge={spfLookupBadge(result.spf_lookup_count)}>
        {spfAdvice(result.spf_result, result.spf_record, result.spf_lookup_count)}
      </ProtocolCard>
      <ProtocolCard title="DKIM" result={result.dkim_result} domain={result.dkim_domain}>
        {dkimAdvice(result.dkim_result)}
      </ProtocolCard>
      <ProtocolCard title="DMARC" result={result.dmarc_result} record={result.dmarc_record}>
        {dmarcAdvice(result.dmarc_result, result.dmarc_policy, result.dmarc_record)}
      </ProtocolCard>

      <button onClick={onReset} style={{
        marginTop: '1.5rem', padding: '0.5rem 1.25rem',
        background: '#111827', color: '#fff', border: 'none',
        borderRadius: '6px', cursor: 'pointer', fontSize: '0.875rem',
      }}>
        Run another check
      </button>
    </div>
  );
}

// ── History ────────────────────────────────────────────────────────────────

function HistoryBadge({ status }: { status: string }) {
  const b = overallBadge(status);
  return (
    <span style={{
      padding: '2px 8px', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 700,
      color: b.color, background: b.bg, whiteSpace: 'nowrap',
    }}>{b.text}</span>
  );
}

function HistoryRow({ r, expanded, onToggle }: {
  r: CheckResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  const mobile = useIsMobile();
  const ts = new Date(r.created_at * 1000).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

  return (
    <div style={{ borderBottom: '1px solid #f3f4f6' }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', width: '100%',
          padding: '0.75rem 0', background: 'none', border: 'none',
          cursor: 'pointer', textAlign: 'left', gap: '0.75rem',
        }}
      >
        {mobile ? (
          // Card-style on mobile
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
              <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#111827' }}>{r.from_domain}</span>
              <HistoryBadge status={r.overall_status} />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.75rem', color: '#6b7280', flexWrap: 'wrap' }}>
              <span>{r.from_email}</span>
              <span>·</span>
              <span style={{ color: statusColor(r.spf_result) }}>SPF {r.spf_result ?? '—'}</span>
              <span>·</span>
              <span style={{ color: statusColor(r.dkim_result) }}>DKIM {r.dkim_result ?? '—'}</span>
              <span>·</span>
              <span style={{ color: statusColor(r.dmarc_result) }}>DMARC {r.dmarc_result ?? '—'}</span>
              <span>·</span>
              <span>{ts}</span>
            </div>
          </div>
        ) : (
          // Table-row style on desktop
          <>
            <span style={{ flex: '0 0 180px', fontWeight: 600, fontSize: '0.875rem', color: '#111827' }}>{r.from_domain}</span>
            <span style={{ flex: '0 0 90px' }}><HistoryBadge status={r.overall_status} /></span>
            <span style={{ flex: '0 0 60px', fontSize: '0.8rem', color: statusColor(r.spf_result), fontWeight: 600 }}>
              SPF {r.spf_result === 'pass' ? '✓' : r.spf_result === 'fail' ? '✗' : '—'}
            </span>
            <span style={{ flex: '0 0 70px', fontSize: '0.8rem', color: statusColor(r.dkim_result), fontWeight: 600 }}>
              DKIM {r.dkim_result === 'pass' ? '✓' : r.dkim_result === 'fail' ? '✗' : '—'}
            </span>
            <span style={{ flex: '0 0 80px', fontSize: '0.8rem', color: statusColor(r.dmarc_result), fontWeight: 600 }}>
              DMARC {r.dmarc_result === 'pass' ? '✓' : r.dmarc_result === 'fail' ? '✗' : '—'}
            </span>
            <span style={{ flex: 1, fontSize: '0.8rem', color: '#9ca3af', textAlign: 'right' }}>{ts}</span>
          </>
        )}
        <span style={{ color: '#9ca3af', fontSize: '0.75rem', flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div style={{
          paddingBottom: '1.25rem', paddingLeft: mobile ? 0 : '0.5rem',
          borderTop: '1px solid #f9fafb',
        }}>
          <ProtocolCard title="SPF" result={r.spf_result} record={r.spf_record} domain={r.spf_domain} badge={spfLookupBadge(r.spf_lookup_count)}>
            {spfAdvice(r.spf_result, r.spf_record, r.spf_lookup_count)}
          </ProtocolCard>
          <ProtocolCard title="DKIM" result={r.dkim_result} domain={r.dkim_domain}>
            {dkimAdvice(r.dkim_result)}
          </ProtocolCard>
          <ProtocolCard title="DMARC" result={r.dmarc_result} record={r.dmarc_record}>
            {dmarcAdvice(r.dmarc_result, r.dmarc_policy, r.dmarc_record)}
          </ProtocolCard>
        </div>
      )}
    </div>
  );
}

function CheckHistory({ results, refreshKey }: { results: CheckResult[]; refreshKey: number }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const mobile = useIsMobile();

  // Auto-expand newest result when refreshKey changes (new check arrived)
  const prevKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey !== prevKey.current && results.length > 0) {
      setExpanded(results[0].id);
      prevKey.current = refreshKey;
    }
  }, [refreshKey, results]);

  if (results.length === 0) return null;

  return (
    <div style={{ marginTop: '2.5rem' }}>
      <h2 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#374151', marginBottom: '0.75rem' }}>
        Recent checks
      </h2>

      {!mobile && (
        <div style={{
          display: 'flex', padding: '0 0 0.4rem', borderBottom: '2px solid #e5e7eb',
          fontSize: '0.75rem', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          <span style={{ flex: '0 0 180px' }}>Domain</span>
          <span style={{ flex: '0 0 90px' }}>Status</span>
          <span style={{ flex: '0 0 60px' }}>SPF</span>
          <span style={{ flex: '0 0 70px' }}>DKIM</span>
          <span style={{ flex: '0 0 80px' }}>DMARC</span>
          <span style={{ flex: 1, textAlign: 'right' }}>Checked</span>
          <span style={{ width: '24px' }} />
        </div>
      )}

      {results.map(r => (
        <HistoryRow
          key={r.id}
          r={r}
          expanded={expanded === r.id}
          onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
        />
      ))}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export function EmailCheck() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [session, setSession] = useState<CheckSession | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<CheckResult[]>([]);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  useEffect(() => {
    getCheckResults().then(d => setHistory(d.results)).catch(() => {});
    return () => stopPolling();
  }, []);

  async function start() {
    try {
      const s = await createSession();
      setSession(s);
      setPhase('waiting');
      pollRef.current = setInterval(async () => {
        try {
          const r = await pollSession(s.token);
          if (r.status === 'done' && r.result) {
            stopPolling();
            setResult(r.result);
            setPhase('done');
            // refresh history and signal new entry
            getCheckResults().then(d => {
              setHistory(d.results);
              setHistoryRefreshKey(k => k + 1);
            }).catch(() => {});
          }
        } catch { /* keep polling */ }
      }, 3000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to start check');
      setPhase('error');
    }
  }

  function reset() {
    stopPolling();
    setPhase('idle');
    setSession(null);
    setResult(null);
    setError('');
    setCopied(false);
  }

  function copy() {
    if (!session) return;
    navigator.clipboard.writeText(session.email);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.25rem' }}>Email check</h1>
        <a href="#/" style={{ fontSize: '0.875rem', color: '#6b7280', textDecoration: 'none' }}>← Overview</a>
      </div>

      {phase === 'idle' && (
        <div style={{ maxWidth: '480px' }}>
          <p style={{ color: '#374151', lineHeight: '1.6', marginBottom: '1.5rem' }}>
            Sends a test email through this address and we'll immediately audit SPF, DKIM, and DMARC
            for the sending domain — plus give you specific recommendations.
          </p>
          <button onClick={start} style={{
            padding: '0.6rem 1.5rem', background: '#111827', color: '#fff',
            border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '0.9rem',
          }}>
            Start check
          </button>
        </div>
      )}

      {phase === 'waiting' && session && (
        <div style={{ maxWidth: '560px' }}>
          <p style={{ color: '#374151', marginBottom: '0.75rem', lineHeight: '1.6' }}>
            Send any email from the domain you want to audit to this address:
          </p>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
            background: '#f9fafb', border: '1px solid #e5e7eb',
            borderRadius: '8px', padding: '0.75rem 1rem', marginBottom: '1.25rem',
          }}>
            <code style={{ flex: 1, fontSize: '0.875rem', wordBreak: 'break-all', color: '#111827' }}>
              {session.email}
            </code>
            <button onClick={copy} style={{
              flexShrink: 0, padding: '4px 12px', fontSize: '0.8rem',
              background: copied ? '#dcfce7' : '#fff', color: copied ? '#15803d' : '#374151',
              border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer',
              transition: 'all 0.15s',
            }}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: '#6b7280', fontSize: '0.875rem' }}>
            <span style={{ display: 'inline-block', width: '12px', height: '12px', borderRadius: '50%',
              background: '#6b7280', animation: 'pulse 1.5s ease-in-out infinite' }} />
            Waiting for email… (checking every 3s)
          </div>
          <p style={{ marginTop: '1rem', fontSize: '0.8rem', color: '#9ca3af', lineHeight: '1.5' }}>
            You can use any email client or the <code>curl</code> / <code>swaks</code> command line.
            The result appears the moment we receive and process it.
          </p>
          <button onClick={reset} style={{
            marginTop: '1rem', padding: '0.4rem 1rem', fontSize: '0.8rem',
            background: 'none', color: '#6b7280', border: '1px solid #d1d5db',
            borderRadius: '6px', cursor: 'pointer',
          }}>Cancel</button>
        </div>
      )}

      {phase === 'done' && result && (
        <CheckReport result={result} onReset={reset} />
      )}

      {phase === 'error' && (
        <div>
          <p style={{ color: '#dc2626' }}>Error: {error}</p>
          <button onClick={reset} style={{ padding: '0.4rem 1rem', cursor: 'pointer' }}>Try again</button>
        </div>
      )}

      <CheckHistory results={history} refreshKey={historyRefreshKey} />
    </div>
  );
}
