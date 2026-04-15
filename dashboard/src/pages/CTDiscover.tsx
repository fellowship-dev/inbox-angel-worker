import { useState } from 'preact/hooks';
import { ctDiscover, bulkImport } from '../api';
import type { BulkImportItemResult } from '../api';

interface Props {
  onUnauthorized: () => void;
}

export function CTDiscover({ onUnauthorized }: Props) {
  const [domain, setDomain] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [importing, setImporting] = useState(false);
  const [subdomains, setSubdomains] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [importResults, setImportResults] = useState<BulkImportItemResult[] | null>(null);
  const [importSummary, setImportSummary] = useState<{ imported: number; total: number } | null>(null);

  const discover = async (e: Event) => {
    e.preventDefault();
    const d = domain.trim().toLowerCase();
    if (!d) return;
    setDiscovering(true);
    setDiscoverError(null);
    setSubdomains(null);
    setSelected(new Set());
    setImportResults(null);
    setImportSummary(null);
    try {
      const res = await ctDiscover(d);
      setSubdomains(res.subdomains);
      // Pre-select all by default
      setSelected(new Set(res.subdomains));
    } catch (e: any) {
      if (e.message === '401') { onUnauthorized(); return; }
      setDiscoverError(e.message ?? 'Discovery failed');
    } finally {
      setDiscovering(false);
    }
  };

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(subdomains ?? []) : new Set());
  };

  const toggle = (sub: string, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (checked) next.add(sub); else next.delete(sub);
      return next;
    });
  };

  const importSelected = async () => {
    if (selected.size === 0) return;
    setImporting(true);
    setImportResults(null);
    setImportSummary(null);
    try {
      const res = await bulkImport(Array.from(selected).join('\n'));
      setImportResults(res.results);
      setImportSummary({ imported: res.imported, total: res.total });
    } catch (e: any) {
      if (e.message === '401') { onUnauthorized(); return; }
      setDiscoverError(e.message ?? 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const allSelected = subdomains !== null && subdomains.length > 0 && selected.size === subdomains.length;

  return (
    <div style={s.page}>
      <a href="#/" style={s.back}>← Back</a>
      <h1 style={s.title}>Discover subdomains</h1>
      <p style={s.subtitle}>
        Enter a root domain to find known subdomains via Certificate Transparency logs (crt.sh).
        Then select which ones to import.
      </p>

      <form onSubmit={discover} style={s.form}>
        <label style={s.label} htmlFor="ct-domain-input">Root domain</label>
        <div style={s.inputRow}>
          <input
            id="ct-domain-input"
            type="text"
            placeholder="example.com"
            value={domain}
            onInput={(e) => setDomain((e.target as HTMLInputElement).value)}
            style={s.input}
            autoFocus
          />
          <button type="submit" style={s.discoverBtn} disabled={discovering || !domain.trim()}>
            {discovering ? 'Searching…' : 'Discover'}
          </button>
        </div>
        {discoverError && <p style={s.error}>{discoverError}</p>}
      </form>

      {subdomains !== null && (
        <div style={s.results}>
          {subdomains.length === 0 ? (
            <p style={s.empty}>No subdomains found in CT logs for <code style={s.code}>{domain}</code>.</p>
          ) : (
            <>
              <div style={s.selectHeader}>
                <label style={s.checkLabel}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) => toggleAll((e.target as HTMLInputElement).checked)}
                    style={s.checkbox}
                  />
                  <strong>{subdomains.length} subdomain{subdomains.length !== 1 ? 's' : ''} found</strong>
                </label>
                <span style={s.selectedCount}>{selected.size} selected</span>
              </div>
              <div style={s.list}>
                {subdomains.map(sub => (
                  <label key={sub} style={s.item}>
                    <input
                      type="checkbox"
                      checked={selected.has(sub)}
                      onChange={(e) => toggle(sub, (e.target as HTMLInputElement).checked)}
                      style={s.checkbox}
                    />
                    <code style={s.code}>{sub}</code>
                  </label>
                ))}
              </div>
              <button
                style={{ ...s.importBtn, ...(selected.size === 0 || importing ? s.importBtnDisabled : {}) }}
                disabled={selected.size === 0 || importing}
                onClick={importSelected}
              >
                {importing ? 'Importing…' : `Import ${selected.size} selected →`}
              </button>
            </>
          )}
        </div>
      )}

      {importSummary && (
        <div style={{ ...s.summaryBadge, ...(importSummary.imported > 0 ? s.summaryGreen : s.summaryGray) }}>
          {importSummary.imported} of {importSummary.total} domain{importSummary.total !== 1 ? 's' : ''} imported
        </div>
      )}

      {importResults && importResults.length > 0 && (
        <>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Domain</th>
                <th style={s.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {importResults.map(r => (
                <tr key={r.domain}>
                  <td style={s.td}><code style={s.code}>{r.domain}</code></td>
                  <td style={s.td}>
                    <span style={{ ...s.badge, ...STATUS_STYLE[r.status] }}>{r.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {importSummary && importSummary.imported > 0 && (
            <a href="#/" style={s.doneBtn}>← View all domains</a>
          )}
        </>
      )}
    </div>
  );
}

const STATUS_STYLE: Record<'imported' | 'duplicate' | 'invalid' | 'error', { background: string; color: string }> = {
  imported:  { background: '#dcfce7', color: '#15803d' },
  duplicate: { background: '#f3f4f6', color: '#6b7280' },
  invalid:   { background: '#fee2e2', color: '#b91c1c' },
  error:     { background: '#fee2e2', color: '#b91c1c' },
};

const s = {
  page: { maxWidth: '640px' },
  back: {
    fontSize: '0.875rem',
    color: '#6b7280',
    textDecoration: 'none',
    display: 'inline-block',
    marginBottom: '2rem',
  } as const,
  title: { margin: '0 0 0.75rem', fontSize: '1.75rem', fontWeight: 700, letterSpacing: '-0.02em' },
  subtitle: { margin: '0 0 2rem', color: '#6b7280', fontSize: '1rem', lineHeight: 1.6 },
  form: { display: 'flex', flexDirection: 'column' as const, gap: '0.75rem', marginBottom: '1.5rem' },
  label: { fontSize: '0.875rem', fontWeight: 600, color: '#374151' } as const,
  inputRow: { display: 'flex', gap: '0.5rem' },
  input: {
    flex: 1,
    padding: '0.75rem 1rem',
    border: '1.5px solid #d1d5db',
    borderRadius: '8px',
    fontSize: '1rem',
    outline: 'none',
  },
  discoverBtn: {
    padding: '0.75rem 1.25rem',
    background: '#111827',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  error: { color: '#dc2626', fontSize: '0.875rem', margin: 0 },
  results: {
    background: '#f9fafb',
    border: '1.5px solid #e5e7eb',
    borderRadius: '8px',
    padding: '1rem',
    marginBottom: '1.5rem',
  },
  empty: { color: '#6b7280', fontSize: '0.9rem', margin: 0 },
  selectHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.75rem',
  },
  checkLabel: { display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9rem' },
  selectedCount: { fontSize: '0.8rem', color: '#9ca3af' },
  checkbox: { cursor: 'pointer', width: '14px', height: '14px' },
  list: { display: 'flex', flexDirection: 'column' as const, gap: '0.35rem', marginBottom: '1rem', maxHeight: '300px', overflowY: 'auto' as const },
  item: { display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', padding: '0.2rem 0' },
  code: { fontFamily: 'monospace', fontSize: '0.875rem' },
  importBtn: {
    padding: '0.65rem 1.25rem',
    background: '#111827',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '0.95rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  importBtnDisabled: { opacity: 0.5, cursor: 'not-allowed' as const },
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
