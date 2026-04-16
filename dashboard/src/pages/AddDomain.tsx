import { useState, useEffect, useRef } from 'preact/hooks';
import { addDomain, checkDomainDns, fetchZones } from '../api';
import type { CfZone } from '../api';
import type { AddDomainResult, ParentContext } from '../types';

interface Props {
  onUnauthorized: () => void;
}

type Step = 'input' | 'setup';

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={s.field}>
      <div style={s.fieldLabel}>{label}</div>
      <div style={s.fieldRow}>
        <code style={s.fieldValue}>{value}</code>
        <button style={s.copyBtn} onClick={copy}>{copied ? 'Copied!' : 'Copy'}</button>
      </div>
    </div>
  );
}

type DnsStatus = 'checking' | 'found' | 'missing-rua' | 'not-found' | 'error';

function SubdomainInheritanceBanner({ pc, subdomain }: { pc: ParentContext; subdomain: string }) {
  let dmarcMsg: { icon: string; text: string; bg: string; color: string };
  // RFC 7489 §6.3: when sp= is absent, the p= policy applies to subdomains.
  // So effective subdomain policy = explicit sp= if present, otherwise p=.
  const effectiveSp = pc.dmarc_sp ?? pc.dmarc_policy;
  if (!pc.has_dmarc) {
    dmarcMsg = {
      icon: '⚠️',
      text: `No DMARC record found on ${pc.domain}. Consider setting up ${pc.domain} first, then return here.`,
      bg: '#fef9c3', color: '#92400e',
    };
  } else if (effectiveSp === 'reject') {
    const via = pc.dmarc_sp === 'reject' ? 'sp=reject' : `p=reject (sp= not set, inherits p=)`;
    dmarcMsg = {
      icon: '✓',
      text: `${pc.domain} enforces ${via} — this subdomain is already protected by the parent's policy. We still recommend adding an explicit _dmarc.${subdomain} record for independent control.`,
      bg: '#dcfce7', color: '#15803d',
    };
  } else {
    const spDesc = pc.dmarc_sp !== null ? `sp=${pc.dmarc_sp}` : `no sp= tag (inherits p=${pc.dmarc_policy ?? 'none'})`;
    dmarcMsg = {
      icon: '⚠️',
      text: `${pc.domain} does not enforce a subdomain reject policy (${spDesc}). This subdomain can be spoofed. Add the DMARC record below to protect it independently.`,
      bg: '#fef9c3', color: '#92400e',
    };
  }

  return (
    <div style={s.subBanner}>
      <div style={s.subBannerTitle}>
        Subdomain of <strong>{pc.domain}</strong> — inheritance summary
      </div>
      <div style={{ ...s.subBannerRow, background: dmarcMsg.bg, color: dmarcMsg.color }}>
        <span>{dmarcMsg.icon}</span>
        <span><strong>DMARC:</strong> {dmarcMsg.text}</span>
      </div>
      <div style={s.subBannerRow}>
        <span>ℹ️</span>
        <span><strong>SPF:</strong> SPF does not inherit. {subdomain} needs its own SPF record.</span>
      </div>
      <div style={s.subBannerRow}>
        <span>ℹ️</span>
        <span><strong>DKIM:</strong> DKIM does not inherit. Check with your email provider for subdomain signing setup.</span>
      </div>
    </div>
  );
}

export function AddDomain({ onUnauthorized }: Props) {
  const [step, setStep] = useState<Step>('input');
  const [input, setInput] = useState('');
  const [zones, setZones] = useState<CfZone[] | null>(null);
  const [result, setResult] = useState<AddDomainResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dnsStatus, setDnsStatus] = useState<DnsStatus>('checking');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchZones().then(r => setZones(r.zones)).catch(() => setZones([]));
  }, []);

  useEffect(() => {
    if (step !== 'setup' || !result) return;
    const check = async () => {
      try {
        const { found, has_rua } = await checkDomainDns(result.domain.id);
        if (found && has_rua) { setDnsStatus('found'); clearInterval(pollRef.current!); }
        else if (found) setDnsStatus('missing-rua');
        else setDnsStatus('not-found');
      } catch { setDnsStatus('error'); }
    };
    check();
    pollRef.current = setInterval(check, 15000);
    return () => clearInterval(pollRef.current!);
  }, [step, result]);

  const submit = async (e: Event) => {
    e.preventDefault();
    const domain = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!domain) return;
    setLoading(true);
    setError(null);
    try {
      const res = await addDomain(domain);
      setResult(res);
      setStep('setup');
    } catch (e: any) {
      if (e.message === '401') { onUnauthorized(); return; }
      setError(e.message ?? 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const dmarcRecord = result
    ? `v=DMARC1; p=none; rua=mailto:${result.domain.rua_address}`
    : '';

  if (step === 'input') {
    return (
      <div style={s.page}>
        <a href="#/" style={s.back}>← Back</a>
        <div style={s.hero}>
          <h1 style={s.title}>Add a domain</h1>
          <p style={s.subtitle}>
            Enter the domain you send email from. We'll check its current security
            settings and guide you through the setup.
          </p>
        </div>
        <form onSubmit={submit} style={s.form}>
          <label style={s.label} htmlFor="domain-input">Your domain</label>
          {zones && zones.length > 0 ? (
            <>
              <select
                id="domain-input"
                value={input}
                onChange={e => setInput((e.target as HTMLSelectElement).value)}
                style={{ ...s.input, cursor: 'pointer', background: 'white' }}
              >
                <option value="">— Select a domain from your Cloudflare account —</option>
                {zones.map(z => (
                  <option key={z.id} value={z.name}>{z.name}</option>
                ))}
              </select>
              <p style={{ fontSize: '0.8rem', color: '#6b7280', margin: 0 }}>
                Not listed?{' '}
                <button
                  type="button"
                  onClick={() => setZones([])}
                  style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', padding: 0, fontSize: '0.8rem' }}
                >
                  Enter manually
                </button>
              </p>
            </>
          ) : (
            <input
              id="domain-input"
              type="text"
              placeholder="yourcompany.com"
              value={input}
              onInput={(e) => setInput((e.target as HTMLInputElement).value)}
              style={s.input}
              autoFocus
            />
          )}
          {error && <p style={s.error}>{error}</p>}
          <button type="submit" style={s.primaryBtn} disabled={loading}>
            {loading ? 'Setting up…' : 'Continue →'}
          </button>
        </form>
        <div style={s.reassurance}>
          <div style={s.reassuranceItem}>
            <strong>No impact on your email.</strong> We start in observation mode —
            nothing changes about how your email is delivered.
          </div>
          <div style={s.reassuranceItem}>
            <strong>Guided setup.</strong> We'll walk you through each step and
            can apply DNS changes automatically if your domain is on Cloudflare.
          </div>
          <div style={s.reassuranceItem}>
            <strong>Clear next steps.</strong> Once data starts coming in, the
            dashboard tells you exactly what to do and when it's safe.
          </div>
        </div>
      </div>
    );
  }

  // step === 'setup'
  return (
    <div style={s.page}>
      <div style={s.successBadge}>✓ Domain added</div>
      {result!.parent_context && (
        <SubdomainInheritanceBanner pc={result!.parent_context} subdomain={result!.domain.domain} />
      )}
      <h1 style={s.title}>Add this DNS record</h1>
      <p style={s.subtitle}>
        Log in to wherever you manage <strong>{result!.domain.domain}</strong> — GoDaddy,
        Namecheap, Cloudflare, Route 53, etc. — and add this TXT record:
      </p>

      <div style={s.recordCard}>
        <CopyField label="Type" value="TXT" />
        <CopyField label="Name / Host" value={`_dmarc.${result!.domain.domain}`} />
        <CopyField label="Value / Content" value={dmarcRecord} />
        <div style={s.ttlHint}>TTL: 3600 (or whatever your provider defaults to)</div>
      </div>

      <div style={s.note}>
        <strong>p=none</strong> means you're just watching. No email gets blocked or
        redirected. Once DMARC reports start coming in (usually within 24h), your dashboard
        will show you whether your mail is fully aligned and when it's safe to enforce.
      </div>

      {result!.manual_dns && result!.dns_instructions && (
        <div style={s.manualNote}>
          <strong>Also add:</strong> {result!.dns_instructions}
        </div>
      )}

      <div style={{ ...s.dnsStatus, ...(dnsStatus === 'found' ? s.dnsFound : dnsStatus === 'missing-rua' ? s.dnsMissingRua : s.dnsWaiting) }}>
        {dnsStatus === 'checking' && '⏳ Checking for your DNS record…'}
        {dnsStatus === 'not-found' && '⏳ DNS record not detected yet — checks every 15s. DNS changes can take a few minutes to propagate.'}
        {dnsStatus === 'missing-rua' && '⚠️ TXT record found but the rua= address is missing. Double-check you copied the full Value above.'}
        {dnsStatus === 'missing-rua' && <><br /><small>Expected: <code style={{ fontFamily: 'monospace', fontSize: '0.8em' }}>rua=mailto:{result!.domain.rua_address}</code></small></>}
        {dnsStatus === 'found' && '✓ DNS record detected! Reports will start arriving within 24 hours.'}
        {dnsStatus === 'error' && '⚠️ Could not check DNS — add the record above and you\'re done.'}
      </div>

      <a href={`#/domains/${result!.domain.id}`} style={s.primaryBtn}>
        Go to {result!.domain.domain} →
      </a>
    </div>
  );
}

const s = {
  page: {
    maxWidth: '520px',
  },
  back: {
    fontSize: '0.875rem',
    color: '#6b7280',
    textDecoration: 'none',
    display: 'inline-block',
    marginBottom: '2rem',
  } as const,
  hero: {
    marginBottom: '2rem',
  },
  title: {
    margin: '0 0 0.75rem',
    fontSize: '1.75rem',
    fontWeight: 700,
    letterSpacing: '-0.02em',
  },
  subtitle: {
    margin: 0,
    color: '#6b7280',
    fontSize: '1rem',
    lineHeight: 1.6,
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.75rem',
    marginBottom: '2.5rem',
  },
  label: {
    fontSize: '0.875rem',
    fontWeight: 600,
    color: '#374151',
  } as const,
  input: {
    padding: '0.75rem 1rem',
    border: '1.5px solid #d1d5db',
    borderRadius: '8px',
    fontSize: '1.1rem',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  error: {
    color: '#dc2626',
    fontSize: '0.875rem',
    margin: 0,
  },
  primaryBtn: {
    display: 'inline-block',
    padding: '0.75rem 1.5rem',
    background: '#111827',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
    textDecoration: 'none',
    textAlign: 'center' as const,
  } as const,
  reassurance: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '1rem',
    padding: '1.5rem',
    background: '#f9fafb',
    borderRadius: '8px',
    borderLeft: '3px solid #e5e7eb',
  },
  reassuranceItem: {
    fontSize: '0.875rem',
    color: '#374151',
    lineHeight: 1.5,
  } as const,
  successBadge: {
    display: 'inline-block',
    background: '#dcfce7',
    color: '#16a34a',
    fontSize: '0.8rem',
    fontWeight: 600,
    padding: '0.25rem 0.6rem',
    borderRadius: '4px',
    marginBottom: '1.25rem',
  },
  recordCard: {
    border: '1.5px solid #e5e7eb',
    borderRadius: '8px',
    overflow: 'hidden',
    marginBottom: '1.5rem',
  },
  field: {
    padding: '0.85rem 1rem',
    borderBottom: '1px solid #f3f4f6',
  },
  fieldLabel: {
    fontSize: '0.7rem',
    fontWeight: 600,
    color: '#9ca3af',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: '0.35rem',
  },
  fieldRow: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' as const },
  fieldValue: {
    flex: 1,
    minWidth: '60%',
    fontFamily: 'monospace',
    fontSize: '0.875rem',
    color: '#111827',
    wordBreak: 'break-all' as const,
  },
  copyBtn: {
    padding: '0.25rem 0.75rem',
    background: '#111827',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    fontSize: '0.75rem',
    cursor: 'pointer',
    flexShrink: 0,
  },
  ttlHint: {
    padding: '0.6rem 1rem',
    fontSize: '0.75rem',
    color: '#9ca3af',
  },
  note: {
    fontSize: '0.875rem',
    color: '#374151',
    lineHeight: 1.6,
    padding: '1rem',
    background: '#f9fafb',
    borderRadius: '8px',
    marginBottom: '1.5rem',
  } as const,
  manualNote: {
    fontSize: '0.875rem',
    color: '#374151',
    background: '#fef9c3',
    padding: '0.75rem 1rem',
    borderRadius: '8px',
    marginBottom: '1.5rem',
  },
  dnsStatus: {
    fontSize: '0.875rem',
    lineHeight: 1.5,
    padding: '0.75rem 1rem',
    borderRadius: '8px',
    marginBottom: '1.5rem',
  },
  dnsWaiting: { background: '#f3f4f6', color: '#374151' },
  dnsFound: { background: '#dcfce7', color: '#15803d' },
  dnsMissingRua: { background: '#fef9c3', color: '#92400e' },
  subBanner: {
    border: '1.5px solid #e5e7eb',
    borderRadius: '8px',
    overflow: 'hidden',
    marginBottom: '1.5rem',
    fontSize: '0.875rem',
  },
  subBannerTitle: {
    background: '#f3f4f6',
    padding: '0.6rem 1rem',
    fontWeight: 600,
    color: '#374151',
    borderBottom: '1px solid #e5e7eb',
  },
  subBannerRow: {
    display: 'flex',
    gap: '0.5rem',
    padding: '0.6rem 1rem',
    borderBottom: '1px solid #f3f4f6',
    lineHeight: 1.5,
    color: '#374151',
    background: '#fff',
  } as const,
};
