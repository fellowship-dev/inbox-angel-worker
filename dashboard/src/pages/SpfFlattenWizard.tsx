import { useState, useEffect } from 'preact/hooks';
import { getSpfFlattenStatus, getSpfLookupCount, enableSpfFlatten, getOnboardingStatus, previewSpfFlatten } from '../api';
import type { SpfFlatStatus } from '../types';
import { CodeBlock, StepProgress, StepNav, useCopyClipboard, wizardStyles as ws } from '../components/WizardKit';
import { useIsMobile } from '../hooks';

interface Props {
  domainId: number;
  onUnauthorized: () => void;
}

export function SpfFlattenWizard({ domainId, onUnauthorized }: Props) {
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<SpfFlatStatus | null>(null);
  const [spfRecord, setSpfRecord] = useState<string | null>(null);
  const [lookupCount, setLookupCount] = useState<number | null>(null);
  const [flattenedPreview, setFlattenedPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, copy] = useCopyClipboard();
  const mobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const flat = await getSpfFlattenStatus(domainId);
        if (cancelled) return;
        setStatus(flat);

        // Get SPF record: from config if available, else from onboarding status
        let record = flat.config?.canonical_record ?? null;
        if (!record) {
          const obs = await getOnboardingStatus(domainId);
          if (cancelled) return;
          record = obs.spf.record;
        }
        setSpfRecord(record);

        // Get lookup count
        const count = flat.lookup_count ?? flat.config?.lookup_count ?? null;
        if (record && count === null) {
          const { lookup_count } = await getSpfLookupCount(record);
          if (cancelled) return;
          setLookupCount(lookup_count);
        } else {
          setLookupCount(count);
        }

        // Get flattened preview — from config if active, otherwise resolve live via API
        if (flat.config?.flattened_record) {
          setFlattenedPreview(flat.config.flattened_record);
        } else {
          // Resolve IPs without enabling — preview only
          try {
            const preview = await previewSpfFlatten(domainId);
            if (!cancelled) {
              setFlattenedPreview(preview.flattened_record);
            }
          } catch {
            // Non-critical — wizard still works without preview
          }
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
  const countColor = lookupCount !== null && lookupCount >= 10 ? '#b91c1c'
    : lookupCount !== null && lookupCount >= 8 ? '#92400e' : '#15803d';
  const countBg = lookupCount !== null && lookupCount >= 10 ? '#fee2e2'
    : lookupCount !== null && lookupCount >= 8 ? '#fef3c7' : '#dcfce7';
  const stepLabels = ['Analyze', 'Compare', 'Enable', 'Done'];

  return (
    <div style={ws.wrap}>
      <a href={`#/domains/${domainId}`} style={{ fontSize: '0.85rem', color: '#6b7280', textDecoration: 'none', display: 'inline-block', marginBottom: '1rem' }}>
        ← Back to domain
      </a>
      <h2 style={{ margin: '0 0 1.5rem', fontSize: '1.35rem', fontWeight: 700 }}>SPF Flattening</h2>

      <StepProgress current={step} total={4} labels={stepLabels} />

      <div style={ws.card}>
        {step === 0 && (
          <>
            <h3 style={ws.stepTitle}>Analyze your SPF record</h3>
            {spfRecord ? (
              <>
                <p style={ws.body}>Your current SPF record:</p>
                <CodeBlock value={spfRecord} onCopy={() => copy(spfRecord)} copied={copied} />
                <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.85rem', color: '#374151' }}>DNS lookups:</span>
                  {lookupCount !== null && (
                    <span style={{
                      padding: '2px 8px', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 700,
                      color: countColor, background: countBg,
                    }}>
                      {lookupCount}/10
                    </span>
                  )}
                </div>
                {lookupCount !== null && lookupCount <= 7 && (
                  <div style={{
                    marginTop: '0.75rem', padding: '0.6rem 0.75rem',
                    background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '6px',
                    fontSize: '0.82rem', color: '#1e40af',
                  }}>
                    Your SPF record is within safe limits. Flattening is optional but still available.
                  </div>
                )}
                {flattenedPreview && (
                  <>
                    <p style={{ ...ws.body, marginTop: '1rem' }}>Flattened preview:</p>
                    <CodeBlock value={flattenedPreview} onCopy={() => copy(flattenedPreview)} copied={copied} />
                  </>
                )}
              </>
            ) : (
              <p style={ws.body}>No SPF record found for this domain. Add one during setup first.</p>
            )}
            {isActive && (
              <div style={{
                marginTop: '1rem', padding: '0.6rem 0.75rem',
                background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px',
                fontSize: '0.82rem', color: '#15803d',
              }}>
                SPF flattening is already active. {status!.config!.ip_count ?? '?'} IPs in flattened record.
              </div>
            )}
            <StepNav
              onNext={() => setStep(1)}
              showSkip={false}
              nextLabel={spfRecord ? 'Continue →' : 'Back to domain'}
              {...(!spfRecord && { onNext: () => { window.location.hash = `#/domains/${domainId}`; } })}
            />
          </>
        )}

        {step === 1 && (
          <>
            <h3 style={ws.stepTitle}>Compare: original vs flattened</h3>
            <p style={ws.body}>
              Flattening resolves all <code style={ws.inline}>include:</code> mechanisms to raw IP addresses, reducing DNS lookups to 1.
              The flattened record is re-resolved daily to pick up upstream provider changes.
            </p>

            <div style={{ marginBottom: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                <p style={{ ...ws.label, marginBottom: 0 }}>Original record</p>
                {lookupCount !== null && (
                  <span style={{
                    padding: '2px 8px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 700,
                    color: countColor, background: countBg,
                  }}>
                    {lookupCount} lookups
                  </span>
                )}
              </div>
              {spfRecord && <CodeBlock value={spfRecord} onCopy={() => copy(spfRecord)} copied={copied} />}
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                <p style={{ ...ws.label, marginBottom: 0 }}>Flattened record</p>
                <span style={{
                  padding: '2px 8px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 700,
                  color: '#15803d', background: '#dcfce7',
                }}>
                  1 lookup
                </span>
              </div>
              {flattenedPreview ? (
                <CodeBlock value={flattenedPreview} onCopy={() => copy(flattenedPreview)} copied={copied} />
              ) : (
                <p style={{ fontSize: '0.82rem', color: '#9ca3af', margin: '0.25rem 0 0' }}>
                  Could not resolve IPs — DNS may be unreachable. The record will be generated when flattening is enabled.
                </p>
              )}
            </div>

            <StepNav onNext={() => setStep(2)} showBack onBack={() => setStep(0)} showSkip={false} />
          </>
        )}

        {step === 2 && (
          <>
            <h3 style={ws.stepTitle}>Enable SPF flattening</h3>
            {isActive ? (
              <div style={{
                padding: '0.75rem', background: '#f0fdf4', border: '1px solid #bbf7d0',
                borderRadius: '6px', fontSize: '0.85rem', color: '#15803d', marginBottom: '1rem',
              }}>
                SPF flattening is already active.
              </div>
            ) : (
              <>
                <p style={ws.body}>
                  This will replace your SPF TXT record with a flattened version containing raw IP addresses.
                  The original record is preserved and used to re-resolve IPs daily.
                </p>
                {spfRecord && (
                  <div style={{ marginBottom: '1rem' }}>
                    <p style={ws.label}>Record to flatten</p>
                    <CodeBlock value={spfRecord} onCopy={() => copy(spfRecord)} copied={copied} />
                  </div>
                )}
              </>
            )}
            {error && <p style={ws.error}>{error}</p>}
            <div style={ws.nav}>
              <button onClick={() => setStep(1)} style={ws.skipLink}>← Back</button>
              {isActive ? (
                <button onClick={() => setStep(3)} style={ws.nextBtn}>Continue →</button>
              ) : (
                <button
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      const { config } = await enableSpfFlatten(domainId);
                      setStatus({ available: true, config, lookup_count: lookupCount });
                      if (config.flattened_record) setFlattenedPreview(config.flattened_record);
                      setStep(3);
                    } catch (e: any) {
                      setError(e.message ?? 'Failed to enable SPF flattening');
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                  style={{ ...ws.actionBtn, opacity: busy ? 0.6 : 1 }}
                >
                  {busy ? 'Enabling…' : 'Enable SPF Flattening'}
                </button>
              )}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h3 style={{ ...ws.stepTitle, color: '#16a34a' }}>SPF flattening enabled</h3>
            <p style={ws.body}>
              Your SPF record has been flattened successfully.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '0.5rem', marginBottom: '1rem' }}>
              {status?.config?.ip_count && (
                <div style={{ fontSize: '0.85rem', color: '#374151' }}>
                  <strong>{status.config.ip_count}</strong> IPs in flattened record
                </div>
              )}
              <div style={{ fontSize: '0.85rem', color: '#6b7280' }}>
                DNS lookups reduced to <strong>1</strong>
              </div>
              <div style={{ fontSize: '0.82rem', color: '#9ca3af' }}>
                IPs are re-resolved daily to track upstream provider changes.
              </div>
            </div>
            {status?.config?.flattened_record && (
              <CodeBlock value={status.config.flattened_record} onCopy={() => copy(status.config!.flattened_record!)} copied={copied} />
            )}
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
