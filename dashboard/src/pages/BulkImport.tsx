import { useState } from 'preact/hooks';
import { bulkImport } from '../api';
import type { BulkImportItemResult } from '../api';

interface Props {
  onUnauthorized: () => void;
}

const STATUS_STYLE: Record<BulkImportItemResult['status'], { background: string; color: string }> = {
  imported:  { background: '#dcfce7', color: '#15803d' },
  duplicate: { background: '#f3f4f6', color: '#6b7280' },
  invalid:   { background: '#fee2e2', color: '#b91c1c' },
  error:     { background: '#fee2e2', color: '#b91c1c' },
};

export function BulkImport({ onUnauthorized }: Props) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<BulkImportItemResult[] | null>(null);
  const [summary, setSummary] = useState<{ imported: number; total: number } | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    setSummary(null);
    try {
      const res = await bulkImport(input);
      setResults(res.results);
      setSummary({ imported: res.imported, total: res.total });
    } catch (e: any) {
      if (e.message === '401') { onUnauthorized(); return; }
      setError(e.message ?? 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={s.page}>
      <a href="#/" style={s.back}>← Back</a>
      <h1 style={s.title}>Bulk domain import</h1>
      <p style={s.subtitle}>
        Paste a list of domains — one per line or comma-separated. All valid domains will be
        created and DNS provisioned immediately.
      </p>

      <form onSubmit={submit} style={s.form}>
        <label style={s.label} htmlFor="domains-input">Domains</label>
        <textarea
          id="domains-input"
          placeholder={'acme.com\nmail.acme.com\nexample.org'}
          value={input}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          style={s.textarea}
          rows={8}
          autoFocus
        />
        {error && <p style={s.error}>{error}</p>}
        <button type="submit" style={s.primaryBtn} disabled={loading || !input.trim()}>
          {loading ? 'Importing…' : 'Import domains →'}
        </button>
      </form>

      {summary && (
        <div style={{ ...s.summaryBadge, ...(summary.imported > 0 ? s.summaryGreen : s.summaryGray) }}>
          {summary.imported} of {summary.total} domain{summary.total !== 1 ? 's' : ''} imported
        </div>
      )}

      {results && results.length > 0 && (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Domain</th>
              <th style={s.th}>Status</th>
              <th style={s.th}>Note</th>
            </tr>
          </thead>
          <tbody>
            {results.map(r => (
              <tr key={r.domain}>
                <td style={s.td}><code style={s.code}>{r.domain}</code></td>
                <td style={s.td}>
                  <span style={{ ...s.badge, ...STATUS_STYLE[r.status] }}>{r.status}</span>
                </td>
                <td style={{ ...s.td, color: '#6b7280', fontSize: '0.8rem' }}>
                  {r.status === 'imported' && r.manual_dns ? 'DNS provisioning: manual required' : ''}
                  {r.status === 'imported' && !r.manual_dns ? 'DNS provisioned' : ''}
                  {r.status === 'duplicate' ? 'Already registered' : ''}
                  {r.error ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {results && summary && summary.imported > 0 && (
        <a href="#/" style={s.doneBtn}>← View all domains</a>
      )}
    </div>
  );
}

const s = {
  page: { maxWidth: '640px' },
  back: {
    fontSize: '0.875rem',
    color: '#6b7280',
    textDecoration: 'none',
    display: 'inline-block',
    marginBottom: '2rem',
  } as const,
  title: {
    margin: '0 0 0.75rem',
    fontSize: '1.75rem',
    fontWeight: 700,
    letterSpacing: '-0.02em',
  },
  subtitle: { margin: '0 0 2rem', color: '#6b7280', fontSize: '1rem', lineHeight: 1.6 },
  form: { display: 'flex', flexDirection: 'column' as const, gap: '0.75rem', marginBottom: '1.5rem' },
  label: { fontSize: '0.875rem', fontWeight: 600, color: '#374151' } as const,
  textarea: {
    padding: '0.75rem 1rem',
    border: '1.5px solid #d1d5db',
    borderRadius: '8px',
    fontSize: '0.95rem',
    fontFamily: 'monospace',
    resize: 'vertical' as const,
    width: '100%',
    boxSizing: 'border-box' as const,
    outline: 'none',
  },
  error: { color: '#dc2626', fontSize: '0.875rem', margin: 0 },
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
    alignSelf: 'flex-start' as const,
  },
  summaryBadge: {
    display: 'inline-block',
    padding: '0.4rem 0.85rem',
    borderRadius: '6px',
    fontWeight: 600,
    fontSize: '0.875rem',
    marginBottom: '1rem',
  },
  summaryGreen: { background: '#dcfce7', color: '#15803d' },
  summaryGray: { background: '#f3f4f6', color: '#6b7280' },
  table: { width: '100%', borderCollapse: 'collapse' as const, marginBottom: '1.5rem' },
  th: {
    textAlign: 'left' as const,
    padding: '0.5rem 0.75rem',
    fontSize: '0.75rem',
    fontWeight: 600,
    color: '#9ca3af',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    borderBottom: '1px solid #e5e7eb',
  },
  td: { padding: '0.6rem 0.75rem', borderBottom: '1px solid #f3f4f6', verticalAlign: 'middle' as const },
  code: { fontFamily: 'monospace', fontSize: '0.875rem' },
  badge: {
    display: 'inline-block',
    padding: '0.2rem 0.5rem',
    borderRadius: '4px',
    fontSize: '0.75rem',
    fontWeight: 600,
  },
  doneBtn: {
    display: 'inline-block',
    padding: '0.65rem 1.25rem',
    background: '#f3f4f6',
    color: '#374151',
    border: 'none',
    borderRadius: '8px',
    fontSize: '0.9rem',
    fontWeight: 600,
    textDecoration: 'none',
    cursor: 'pointer',
  } as const,
};
