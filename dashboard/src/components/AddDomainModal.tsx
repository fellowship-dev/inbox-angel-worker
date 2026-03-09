import { useState } from 'preact/hooks';
import { addDomain } from '../api';
import type { AddDomainResult } from '../types';

interface Props {
  onClose: () => void;
  onAdded: () => void;
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

export function AddDomainModal({ onClose, onAdded }: Props) {
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
      onAdded();
    } catch (e: any) {
      setError(e.message ?? 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const dmarcRecord = result
    ? `v=DMARC1; p=none; rua=mailto:${result.domain.rua_address}`
    : '';

  return (
    <div style={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        {/* Close */}
        <button style={s.closeBtn} onClick={onClose}>✕</button>

        {step === 'input' && (
          <form onSubmit={submit}>
            <h2 style={s.title}>Protect a domain</h2>
            <p style={s.subtitle}>
              Enter your domain and we'll tell you exactly what to add to your DNS.
              It takes about 2 minutes and won't affect your existing email.
            </p>
            <input
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
        )}

        {step === 'setup' && result && (
          <div>
            <div style={s.successBadge}>✓ Domain added</div>
            <h2 style={s.title}>One DNS record to add</h2>
            <p style={s.subtitle}>
              Log in to wherever you manage <strong>{result.domain.domain}</strong> (GoDaddy,
              Namecheap, Cloudflare…) and add this record:
            </p>

            <div style={s.recordCard}>
              <CopyField label="Type" value="TXT" />
              <CopyField label="Name" value={`_dmarc.${result.domain.domain}`} />
              <CopyField label="Value" value={dmarcRecord} />
            </div>

            <p style={s.note}>
              <strong>p=none</strong> means you're just observing — your email delivery won't be
              affected at all. Once reports start coming in, the dashboard will tell you when
              you're ready to tighten your policy.
            </p>

            {result.manual_dns && result.dns_instructions && (
              <div style={s.manualNote}>
                <strong>Also add:</strong> {result.dns_instructions}
              </div>
            )}

            <button style={s.primaryBtn} onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

const s = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    padding: '1rem',
  },
  modal: {
    background: '#fff',
    borderRadius: '12px',
    padding: '2rem',
    width: '100%',
    maxWidth: '480px',
    position: 'relative' as const,
    boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
  },
  closeBtn: {
    position: 'absolute' as const,
    top: '1rem',
    right: '1rem',
    background: 'none',
    border: 'none',
    fontSize: '1rem',
    color: '#9ca3af',
    cursor: 'pointer',
    padding: '0.25rem',
  },
  title: { margin: '0 0 0.5rem', fontSize: '1.25rem', fontWeight: 700 },
  subtitle: { margin: '0 0 1.5rem', color: '#6b7280', fontSize: '0.9rem', lineHeight: 1.6 },
  input: {
    width: '100%',
    padding: '0.65rem 0.75rem',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '1rem',
    marginBottom: '0.75rem',
    boxSizing: 'border-box' as const,
    outline: 'none',
  },
  error: { color: '#dc2626', fontSize: '0.875rem', margin: '0 0 0.75rem' },
  primaryBtn: {
    width: '100%',
    padding: '0.7rem',
    background: '#111827',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: '0.25rem',
  },
  successBadge: {
    display: 'inline-block',
    background: '#dcfce7',
    color: '#16a34a',
    fontSize: '0.8rem',
    fontWeight: 600,
    padding: '0.25rem 0.6rem',
    borderRadius: '4px',
    marginBottom: '1rem',
  },
  recordCard: {
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    overflow: 'hidden',
    marginBottom: '1.25rem',
  },
  field: {
    padding: '0.75rem 1rem',
    borderBottom: '1px solid #f3f4f6',
  },
  fieldLabel: { fontSize: '0.7rem', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: '0.3rem' },
  fieldRow: { display: 'flex', alignItems: 'center', gap: '0.5rem' } as const,
  fieldValue: { flex: 1, fontFamily: 'monospace', fontSize: '0.8rem', color: '#111827', wordBreak: 'break-all' as const },
  copyBtn: { padding: '0.2rem 0.6rem', background: '#f3f4f6', border: 'none', borderRadius: '4px', fontSize: '0.75rem', cursor: 'pointer', flexShrink: 0, color: '#374151' },
  note: { fontSize: '0.8rem', color: '#6b7280', lineHeight: 1.6, margin: '0 0 1.25rem', padding: '0.75rem', background: '#f9fafb', borderRadius: '6px' },
  manualNote: { fontSize: '0.8rem', color: '#374151', background: '#fef9c3', padding: '0.75rem', borderRadius: '6px', marginBottom: '1rem' },
};
