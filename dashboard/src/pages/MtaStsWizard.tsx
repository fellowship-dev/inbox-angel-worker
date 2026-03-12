import { useState, useEffect } from 'preact/hooks';
import { getMtaStsStatus, enableMtaSts, updateMtaStsMode } from '../api';
import type { MtaStsStatus } from '../types';
import { StepProgress, StepNav, wizardStyles as ws } from '../components/WizardKit';
import { useIsMobile } from '../hooks';

interface Props {
  domainId: number;
  onUnauthorized: () => void;
}

export function MtaStsWizard({ domainId, onUnauthorized }: Props) {
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<MtaStsStatus | null>(null);
  const [mode, setMode] = useState<'testing' | 'enforce'>('testing');
  const [mxHosts, setMxHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const mta = await getMtaStsStatus(domainId);
        if (cancelled) return;
        setStatus(mta);
        if (mta.config) {
          setMode(mta.config.mode);
          setMxHosts(mta.config.mx_hosts ? mta.config.mx_hosts.split(',').filter(Boolean) : []);
        }
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
  }, [domainId]);

  if (loading) return <div style={ws.wrap}><p style={{ color: '#9ca3af' }}>Loading…</p></div>;
  if (error && !status) return <div style={ws.wrap}><p style={{ color: '#dc2626' }}>Error: {error}</p></div>;

  const isActive = !!status?.config?.enabled;
  const stepLabels = ['MX Discovery', 'Choose mode', 'Provision', 'Done'];

  return (
    <div style={ws.wrap}>
      <a href={`#/domains/${domainId}`} style={{ fontSize: '0.85rem', color: '#6b7280', textDecoration: 'none', display: 'inline-block', marginBottom: '1rem' }}>
        ← Back to domain
      </a>
      <h2 style={{ margin: '0 0 1.5rem', fontSize: '1.35rem', fontWeight: 700 }}>MTA-STS Setup</h2>

      <StepProgress current={step} total={4} labels={stepLabels} />

      <div style={ws.card}>
        {step === 0 && (
          <>
            <h3 style={ws.stepTitle}>MX Discovery</h3>
            <p style={ws.body}>
              MTA-STS tells sending mail servers to always use TLS when delivering to your domain,
              preventing downgrade attacks. MX hosts are auto-discovered when you enable it.
            </p>
            {isActive && mxHosts.length > 0 && (
              <div style={{
                padding: '0.75rem', background: '#f0fdf4', border: '1px solid #bbf7d0',
                borderRadius: '6px', marginBottom: '1rem',
              }}>
                <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', fontWeight: 600, color: '#15803d' }}>
                  MTA-STS is already active ({status!.config!.mode} mode)
                </p>
                <p style={{ margin: '0 0 0.35rem', fontSize: '0.78rem', color: '#374151', fontWeight: 600 }}>Discovered MX hosts:</p>
                <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.8rem', color: '#374151' }}>
                  {mxHosts.map(h => <li key={h}>{h}</li>)}
                </ul>
              </div>
            )}
            {!isActive && (
              <div style={{
                padding: '0.6rem 0.75rem', background: '#eff6ff', border: '1px solid #bfdbfe',
                borderRadius: '6px', fontSize: '0.82rem', color: '#1e40af',
              }}>
                MX hosts will be automatically discovered from your DNS when MTA-STS is enabled.
              </div>
            )}
            <StepNav onNext={() => setStep(1)} showSkip={false} />
          </>
        )}

        {step === 1 && (
          <>
            <h3 style={ws.stepTitle}>Choose enforcement mode</h3>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '0.75rem', marginBottom: '1rem' }}>
              <label
                onClick={() => setMode('testing')}
                style={{
                  display: 'block', padding: '1rem', borderRadius: '8px', cursor: 'pointer',
                  border: mode === 'testing' ? '2px solid #2563eb' : '1px solid #e5e7eb',
                  background: mode === 'testing' ? '#eff6ff' : '#fff',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                  <input type="radio" checked={mode === 'testing'} onChange={() => setMode('testing')} style={{ margin: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>Testing</span>
                  <span style={{
                    padding: '1px 6px', borderRadius: '9999px', fontSize: '0.68rem', fontWeight: 700,
                    color: '#1d4ed8', background: '#dbeafe',
                  }}>
                    Recommended
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: '0.82rem', color: '#6b7280', paddingLeft: '1.35rem' }}>
                  Report-only mode. Sending servers will report TLS failures but won't reject mail.
                  Start here to verify everything works before enforcing.
                </p>
              </label>
              <label
                onClick={() => setMode('enforce')}
                style={{
                  display: 'block', padding: '1rem', borderRadius: '8px', cursor: 'pointer',
                  border: mode === 'enforce' ? '2px solid #16a34a' : '1px solid #e5e7eb',
                  background: mode === 'enforce' ? '#f0fdf4' : '#fff',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                  <input type="radio" checked={mode === 'enforce'} onChange={() => setMode('enforce')} style={{ margin: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>Enforce</span>
                </div>
                <p style={{ margin: 0, fontSize: '0.82rem', color: '#6b7280', paddingLeft: '1.35rem' }}>
                  Sending servers will reject delivery if TLS cannot be established.
                  Only use after confirming zero TLS failures in testing mode.
                </p>
              </label>
            </div>
            <StepNav onNext={() => setStep(2)} showBack onBack={() => setStep(0)} showSkip={false} />
          </>
        )}

        {step === 2 && (
          <>
            <h3 style={ws.stepTitle}>Provision MTA-STS</h3>
            <p style={ws.body}>
              Enabling MTA-STS will create 3 DNS records for your domain:
            </p>
            <div style={{
              display: 'flex', flexDirection: 'column' as const, gap: '0.5rem', marginBottom: '1rem',
              fontSize: '0.82rem', color: '#374151',
            }}>
              <div style={{ padding: '0.5rem 0.75rem', background: '#f9fafb', borderRadius: '6px', border: '1px solid #e5e7eb' }}>
                <strong>_mta-sts TXT</strong> — MTA-STS policy version identifier
              </div>
              <div style={{ padding: '0.5rem 0.75rem', background: '#f9fafb', borderRadius: '6px', border: '1px solid #e5e7eb' }}>
                <strong>_smtp._tls TXT</strong> — TLS-RPT reporting address for failure reports
              </div>
              <div style={{ padding: '0.5rem 0.75rem', background: '#f9fafb', borderRadius: '6px', border: '1px solid #e5e7eb' }}>
                <strong>mta-sts CNAME</strong> — Points to hosted policy file
              </div>
            </div>
            <div style={{
              padding: '0.6rem 0.75rem', background: mode === 'enforce' ? '#f0fdf4' : '#eff6ff',
              border: `1px solid ${mode === 'enforce' ? '#bbf7d0' : '#bfdbfe'}`,
              borderRadius: '6px', fontSize: '0.82rem', color: mode === 'enforce' ? '#15803d' : '#1e40af',
              marginBottom: '1rem',
            }}>
              Mode: <strong>{mode}</strong>{mode === 'testing' ? ' — failures will be reported but mail will still be delivered.' : ' — mail will be rejected on TLS failure.'}
            </div>
            {error && <p style={ws.error}>{error}</p>}
            {isActive ? (
              <div style={ws.nav}>
                <button onClick={() => setStep(1)} style={ws.skipLink}>← Back</button>
                <button onClick={() => setStep(3)} style={ws.nextBtn}>Continue →</button>
              </div>
            ) : (
              <div style={ws.nav}>
                <button onClick={() => setStep(1)} style={ws.skipLink}>← Back</button>
                <button
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      const result = await enableMtaSts(domainId);
                      setMxHosts(result.mx_hosts ?? []);
                      // If user selected enforce, update mode after enabling
                      if (mode === 'enforce') {
                        await updateMtaStsMode(domainId, 'enforce');
                      }
                      const updated = await getMtaStsStatus(domainId);
                      setStatus(updated);
                      setStep(3);
                    } catch (e: any) {
                      setError(e.message ?? 'Failed to enable MTA-STS');
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                  style={{ ...ws.actionBtn, opacity: busy ? 0.6 : 1 }}
                >
                  {busy ? 'Provisioning…' : 'Enable MTA-STS'}
                </button>
              </div>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <h3 style={{ ...ws.stepTitle, color: '#16a34a' }}>MTA-STS enabled</h3>
            <p style={ws.body}>
              MTA-STS has been provisioned for your domain.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '0.5rem', marginBottom: '1rem' }}>
              <div style={{ fontSize: '0.85rem', color: '#374151' }}>
                Mode: <strong>{status?.config?.mode ?? mode}</strong>
              </div>
              {mxHosts.length > 0 && (
                <div>
                  <p style={{ margin: '0 0 0.35rem', fontSize: '0.82rem', color: '#6b7280', fontWeight: 600 }}>Discovered MX hosts:</p>
                  <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.8rem', color: '#374151' }}>
                    {mxHosts.map(h => <li key={h}>{h}</li>)}
                  </ul>
                </div>
              )}
              <div style={{ fontSize: '0.82rem', color: '#9ca3af', marginTop: '0.25rem' }}>
                3 DNS records created. TLS failure reports will be collected automatically.
              </div>
            </div>
            <div style={{ ...ws.nav, marginTop: '1.5rem' }}>
              <span />
              <a
                href={`#/domains/${domainId}`}
                style={{ ...ws.nextBtn, textDecoration: 'none', display: 'inline-block', textAlign: 'center' as const }}
              >
                Back to domain →
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
