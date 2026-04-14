import { useEffect, useState } from 'preact/hooks';
import { getDomains, deleteDomain, getMonitorSubs, setMonitorSubActive, setDomainAlerts } from '../api';
import type { MonitorSub } from '../api';
import type { Domain } from '../types';
import { formatDate } from '../utils/dates';

interface Props {
  id: number;
  onUnauthorized: () => void;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={s.infoRow}>
      <span style={s.infoLabel}>{label}</span>
      <div style={s.infoValueRow}>
        <code style={s.infoValue}>{value}</code>
        <button style={s.copyBtn} onClick={copy}>{copied ? 'Copied!' : 'Copy'}</button>
      </div>
    </div>
  );
}

export function DomainSettings({ id, onUnauthorized }: Props) {
  const [domain, setDomain] = useState<Domain | null>(null);
  const [subs, setSubs] = useState<MonitorSub[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [togglingAlerts, setTogglingAlerts] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getDomains(), getMonitorSubs(id)])
      .then(([{ domains }, { subs }]) => {
        if (cancelled) return;
        setDomain(domains.find(d => d.id === id) ?? null);
        setSubs(subs);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e.message === '401') { onUnauthorized(); return; }
        setError(e.message ?? 'Failed to load');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const toggleAlerts = async () => {
    if (!domain) return;
    setTogglingAlerts(true);
    const next = !domain.alerts_enabled;
    try {
      await setDomainAlerts(id, next);
      setDomain(prev => prev ? { ...prev, alerts_enabled: next ? 1 : 0 } : prev);
    } catch { /* ignore */ } finally {
      setTogglingAlerts(false);
    }
  };

  const toggleSub = async (sub: MonitorSub) => {
    setTogglingId(sub.id);
    try {
      await setMonitorSubActive(sub.id, !sub.active);
      setSubs(prev => prev.map(s => s.id === sub.id ? { ...s, active: sub.active ? 0 : 1 } : s));
    } catch { /* ignore */ } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteDomain(id);
      window.location.hash = '/';
    } catch (e: any) {
      if (e.message === '401') { onUnauthorized(); return; }
      setDeleteError(e.message ?? 'Delete failed');
      setDeleting(false);
    }
  };

  if (loading) return <p style={s.muted}>Loading…</p>;
  if (error) return <p style={{ color: '#dc2626' }}>Error: {error}</p>;
  if (!domain) return <p style={s.muted}>Domain not found.</p>;

  const apiKey = localStorage.getItem('ia_api_key') ?? '';
  const exportUrl = `/api/domains/${id}/export?key=${encodeURIComponent(apiKey)}`;

  return (
    <div>
      <a href={`#/domains/${id}`} style={s.back}>← {domain.domain}</a>
      <h2 style={s.title}>Settings</h2>

      {/* Domain info */}
      <section style={s.section}>
        <h3 style={s.sectionTitle}>Domain info</h3>
        <div style={s.card}>
          <div style={s.infoRow}>
            <span style={s.infoLabel}>Domain</span>
            <span style={s.infoText}>{domain.domain}</span>
          </div>
          <div style={s.divider} />
          <div style={s.infoRow}>
            <span style={s.infoLabel}>Added</span>
            <span style={s.infoText}>{domain.created_at ? formatDate(domain.created_at) : '—'}</span>
          </div>
          <div style={s.divider} />
          <CopyField label="RUA address" value={`rua=mailto:${domain.rua_address}`} />
          <div style={s.divider} />
          <CopyField label="DMARC record" value={`v=DMARC1; p=${domain.dmarc_policy ?? 'none'}; rua=mailto:${domain.rua_address}`} />
        </div>
      </section>

      {/* Export */}
      <section style={s.section}>
        <h3 style={s.sectionTitle}>Export data</h3>
        <div style={s.card}>
          <p style={s.exportDesc}>
            Download all DMARC report data as a CSV file — one row per source per day.
            Includes SPF/DKIM results, sending IPs, and message counts.
            Useful for audits, security reviews, or moving to another service.
          </p>
          <a href={exportUrl} download={`${domain.domain}-dmarc.csv`} style={s.exportBtn}>
            Download CSV
          </a>
        </div>
      </section>

      {/* Monitoring alerts */}
      <section style={s.section}>
        <h3 style={s.sectionTitle}>Monitoring alerts</h3>
        <div style={{ ...s.card, marginBottom: '0.75rem' }}>
          <div style={s.infoRow}>
            <div style={{ flex: 1 }}>
              <div style={s.infoText}>Alerts enabled</div>
              <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '0.15rem' }}>
                {domain.alerts_enabled ? 'Sending change notifications for this domain' : 'All alerts paused for this domain'}
              </div>
            </div>
            <button
              style={{ ...s.copyBtn, background: domain.alerts_enabled ? '#6b7280' : '#111827', opacity: togglingAlerts ? 0.5 : 1 }}
              onClick={toggleAlerts}
              disabled={togglingAlerts}
            >
              {domain.alerts_enabled ? 'Pause all' : 'Resume all'}
            </button>
          </div>
        </div>
        {subs.length === 0 ? (
          <div style={s.card}>
            <p style={{ ...s.exportDesc, paddingBottom: '0.85rem' }}>
              No active monitoring subscriptions for this domain yet. They're created automatically when someone runs a free email check and opts in to alerts.
            </p>
          </div>
        ) : (
          <div style={s.card}>
            {subs.map((sub, i) => (
              <div key={sub.id}>
                {i > 0 && <div style={s.divider} />}
                <div style={s.infoRow}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={s.infoText}>{sub.email}</div>
                    <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '0.15rem' }}>
                      {sub.active ? 'Receiving alerts' : 'Alerts paused'}
                    </div>
                  </div>
                  <button
                    style={{ ...s.copyBtn, background: sub.active ? '#6b7280' : '#111827', opacity: togglingId === sub.id ? 0.5 : 1 }}
                    onClick={() => toggleSub(sub)}
                    disabled={togglingId === sub.id}
                  >
                    {sub.active ? 'Pause' : 'Resume'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Danger zone */}
      <section style={s.section}>
        <h3 style={{ ...s.sectionTitle, color: '#dc2626' }}>Danger zone</h3>
        <div style={s.dangerCard}>
          <div style={s.dangerRow}>
            <div>
              <div style={s.dangerLabel}>Remove this domain</div>
              <div style={s.dangerHint}>
                Deletes {domain.domain} and all associated report data. This cannot be undone.
              </div>
            </div>
            {!confirmDelete ? (
              <button style={s.dangerBtn} onClick={() => setConfirmDelete(true)}>
                Remove domain
              </button>
            ) : (
              <div style={s.confirmGroup}>
                <button style={s.cancelBtn} onClick={() => { setConfirmDelete(false); setDeleteError(null); }}>
                  Cancel
                </button>
                <button style={s.deleteBtn} onClick={handleDelete} disabled={deleting}>
                  {deleting ? 'Removing…' : 'Yes, remove'}
                </button>
              </div>
            )}
          </div>
          {deleteError && <p style={s.deleteError}>{deleteError}</p>}
        </div>
      </section>
    </div>
  );
}

const s = {
  back: { fontSize: '0.875rem', color: '#6b7280', textDecoration: 'none', display: 'inline-block', marginBottom: '1.5rem' } as const,
  title: { margin: '0 0 2rem', fontSize: '1.5rem', fontWeight: 700 },
  muted: { color: '#9ca3af' } as const,

  section: { marginBottom: '2.5rem' } as const,
  sectionTitle: { fontSize: '0.75rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.06em', margin: '0 0 0.75rem' },

  card: { border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' } as const,
  divider: { borderTop: '1px solid #f3f4f6' } as const,

  infoRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.1rem', gap: '1rem', flexWrap: 'wrap' as const },
  infoLabel: { fontSize: '0.8rem', color: '#6b7280', flexShrink: 0, minWidth: '90px' } as const,
  infoText: { fontSize: '0.875rem', color: '#111827' } as const,
  infoValueRow: { display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, justifyContent: 'flex-end', flexWrap: 'wrap' as const },
  infoValue: { fontFamily: 'monospace', fontSize: '0.8rem', color: '#374151', wordBreak: 'break-all' as const },
  copyBtn: { padding: '0.2rem 0.6rem', background: '#111827', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '0.75rem', cursor: 'pointer', flexShrink: 0 } as const,

  exportDesc: { margin: '0 0 1rem', fontSize: '0.875rem', color: '#6b7280', lineHeight: 1.6, padding: '0.85rem 1.1rem 0' } as const,
  exportBtn: { display: 'inline-block', margin: '0 1.1rem 1rem', padding: '0.5rem 1.1rem', background: '#111827', color: '#fff', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 600, textDecoration: 'none' } as const,

  dangerCard: { border: '1px solid #fca5a5', borderRadius: '8px', padding: '1rem 1.1rem' } as const,
  dangerRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' as const },
  dangerLabel: { fontSize: '0.875rem', fontWeight: 600, color: '#111827', marginBottom: '0.25rem' } as const,
  dangerHint: { fontSize: '0.8rem', color: '#6b7280' } as const,
  dangerBtn: { padding: '0.4rem 0.9rem', background: '#fff', border: '1px solid #fca5a5', color: '#dc2626', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', flexShrink: 0 } as const,
  confirmGroup: { display: 'flex', gap: '0.5rem', flexShrink: 0 } as const,
  cancelBtn: { padding: '0.4rem 0.9rem', background: 'none', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.8rem', cursor: 'pointer', color: '#374151' } as const,
  deleteBtn: { padding: '0.4rem 0.9rem', background: '#dc2626', border: 'none', borderRadius: '6px', fontSize: '0.8rem', cursor: 'pointer', color: '#fff', fontWeight: 600 } as const,
  deleteError: { color: '#dc2626', fontSize: '0.8rem', margin: '0.75rem 0 0' } as const,
};
