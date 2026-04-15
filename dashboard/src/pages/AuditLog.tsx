import { useState, useEffect } from 'preact/hooks';
import { getAuditLog } from '../api';
import type { AuditLogEntry } from '../types';
import { formatTimestamp, relativeTime } from '../utils/dates';

const ACTION_COLOR: Record<string, string> = {
  'auth.':        '#6366f1',
  'domain.':      '#0891b2',
  'dns.':         '#d97706',
  'spf_flatten.': '#7c3aed',
  'mta_sts.':     '#0369a1',
  'team.':        '#be185d',
  'cron.':        '#6b7280',
};

function actionColor(action: string): string {
  for (const [prefix, color] of Object.entries(ACTION_COLOR)) {
    if (action.startsWith(prefix)) return color;
  }
  return '#6b7280';
}

function actionBg(action: string): string {
  const color = actionColor(action);
  return color + '18';
}


function JsonExpand({ label, value }: { label: string; value: string | null }) {
  const [open, setOpen] = useState(false);
  if (!value) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = value; }
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      style={{ marginTop: '0.3rem' }}>
      <summary style={{ fontSize: '0.72rem', color: '#9ca3af', cursor: 'pointer', userSelect: 'none' }}>
        {label}
      </summary>
      <pre style={{
        margin: '0.3rem 0 0', padding: '0.5rem 0.75rem',
        background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '6px',
        fontSize: '0.72rem', color: '#374151', overflowX: 'auto', whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      }}>
        {JSON.stringify(parsed, null, 2)}
      </pre>
    </details>
  );
}

function EntryRow({ entry }: { entry: AuditLogEntry }) {
  const color = actionColor(entry.action);
  const bg    = actionBg(entry.action);
  const isSystem = entry.actor_type === 'system';

  return (
    <div style={{
      borderBottom: '1px solid #f3f4f6',
      padding: '0.75rem 0',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
        {/* Action badge */}
        <span style={{
          flexShrink: 0,
          padding: '2px 8px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 700,
          color, background: bg,
        }}>
          {entry.action}
        </span>

        {/* Resource */}
        {entry.resource_name && (
          <span style={{ fontSize: '0.8rem', color: '#374151', alignSelf: 'center' }}>
            {entry.resource_name}
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
          {/* Actor */}
          <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>
            {isSystem
              ? <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>system</span>
              : entry.actor_email ?? entry.actor_id ?? '—'}
          </span>
          {/* Timestamp */}
          <span style={{ fontSize: '0.72rem', color: '#9ca3af', whiteSpace: 'nowrap' }}>
            {formatTimestamp(entry.created_at)}
            <span style={{ color: '#d1d5db', margin: '0 0.3rem' }}>·</span>
            {relativeTime(entry.created_at)}
          </span>
        </div>
      </div>

      {/* Before / After expandable */}
      {(entry.before_value || entry.after_value) && (
        <div style={{ marginTop: '0.25rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <JsonExpand label="before" value={entry.before_value} />
          <JsonExpand label="after"  value={entry.after_value} />
        </div>
      )}
    </div>
  );
}

const ACTION_GROUPS = [
  { label: 'All',         value: '' },
  { label: 'Auth',        value: 'auth.' },
  { label: 'DNS',         value: 'dns.' },
  { label: 'Domains',     value: 'domain.' },
  { label: 'SPF',         value: 'spf_flatten.' },
  { label: 'MTA-STS',     value: 'mta_sts.' },
  { label: 'Team',        value: 'team.' },
  { label: 'Cron',        value: 'cron.' },
];

export function AuditLog({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [page, setPage]       = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [actionFilter, setActionFilter] = useState('');
  const LIMIT = 50;

  async function load(p: number, action: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await getAuditLog({ page: p, limit: LIMIT, action: action || undefined });
      setEntries(res.entries);
      setHasMore(res.entries.length === LIMIT);
    } catch (e: any) {
      if (e.message === '401' || e.message === 'admin required') { onUnauthorized(); return; }
      setError(e.message ?? 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setPage(1);
    load(1, actionFilter);
  }, [actionFilter]);

  function goPage(p: number) {
    setPage(p);
    load(p, actionFilter);
    window.scrollTo(0, 0);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700 }}>Audit Log</h2>
        <p style={{ margin: 0, fontSize: '0.8rem', color: '#6b7280' }}>
          Immutable record of all changes. Admin only.
        </p>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {ACTION_GROUPS.map(g => (
          <button
            key={g.value}
            onClick={() => setActionFilter(g.value)}
            style={{
              padding: '0.25rem 0.65rem', fontSize: '0.75rem', borderRadius: '9999px',
              border: '1px solid',
              borderColor: actionFilter === g.value ? '#111827' : '#d1d5db',
              background: actionFilter === g.value ? '#111827' : '#fff',
              color: actionFilter === g.value ? '#fff' : '#374151',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {g.label}
          </button>
        ))}
      </div>

      {error && <p style={{ color: '#dc2626', fontSize: '0.875rem' }}>{error}</p>}

      {loading ? (
        <p style={{ color: '#9ca3af', fontSize: '0.875rem' }}>Loading…</p>
      ) : entries.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: '0.875rem' }}>No audit entries found.</p>
      ) : (
        <>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '0 1rem' }}>
            {entries.map(e => <EntryRow key={e.id} entry={e} />)}
          </div>

          {/* Pagination */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem' }}>
            <button
              onClick={() => goPage(page - 1)}
              disabled={page === 1}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem', cursor: page === 1 ? 'default' : 'pointer', opacity: page === 1 ? 0.4 : 1, border: '1px solid #d1d5db', borderRadius: '6px', background: '#fff' }}
            >
              ← Prev
            </button>
            <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>Page {page}</span>
            <button
              onClick={() => goPage(page + 1)}
              disabled={!hasMore}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem', cursor: !hasMore ? 'default' : 'pointer', opacity: !hasMore ? 0.4 : 1, border: '1px solid #d1d5db', borderRadius: '6px', background: '#fff' }}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
