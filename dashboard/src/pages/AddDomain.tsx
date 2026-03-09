import { useState } from 'preact/hooks';
import { addDomain } from '../api';
import type { AddDomainResult } from '../types';

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

export function AddDomain({ onUnauthorized }: Props) {
  const [step, setStep] = useState<Step>('input');
  const [input, setInput] = useState('');
  const [result, setResult] = useState<AddDomainResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
          <h1 style={s.title}>Protect a domain</h1>
          <p style={s.subtitle}>
            We'll give you one DNS record to add. Takes 2 minutes. Your email delivery stays
            completely unaffected — we start in monitor-only mode.
          </p>
        </div>
        <form onSubmit={submit} style={s.form}>
          <label style={s.label} htmlFor="domain-input">Your domain</label>
          <input
            id="domain-input"
            type="text"
            placeholder="yourcompany.com"
            value={input}
            onInput={(e) => setInput((e.target as HTMLInputElement).value)}
            style={s.input}
            autoFocus
          />
          {error && <p style={s.error}>{error}</p>}
          <button type="submit" style={s.primaryBtn} disabled={loading}>
            {loading ? 'Setting up…' : 'Continue →'}
          </button>
        </form>
        <div style={s.reassurance}>
          <div style={s.reassuranceItem}>
            <strong>Zero risk to email delivery.</strong> p=none means you're only observing.
            No email gets blocked.
          </div>
          <div style={s.reassuranceItem}>
            <strong>One record, not ten.</strong> Just a single TXT record on your DNS.
          </div>
          <div style={s.reassuranceItem}>
            <strong>We'll tell you what to do next.</strong> Once reports come in, the
            dashboard shows you exactly when it's safe to tighten your policy.
          </div>
        </div>
      </div>
    );
  }

  // step === 'setup'
  return (
    <div style={s.page}>
      <div style={s.successBadge}>✓ Domain added</div>
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
  fieldRow: { display: 'flex', alignItems: 'center', gap: '0.5rem' } as const,
  fieldValue: {
    flex: 1,
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
};
