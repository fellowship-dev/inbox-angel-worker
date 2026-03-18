import { useState, useEffect } from 'preact/hooks';
import { getDomains, checkDomainDns, updateDmarcPolicy } from '../api';
import type { Domain } from '../types';
import { StepProgress, CodeBlock, useCopyClipboard, wizardStyles as ws } from '../components/WizardKit';

interface Props {
  domainId: number;
  onUnauthorized: () => void;
}

const POLICIES = ['none', 'quarantine', 'reject'] as const;
type Policy = typeof POLICIES[number];

const POLICY_STEPS: Record<Policy, number> = { none: 0, quarantine: 1, reject: 2 };

const STEP_COPY: Array<{ title: string; body: string; target: Policy; color: string }> = [
  {
    title: 'Step 1 — Switch to quarantine',
    body: 'Quarantine tells receiving servers to deliver suspicious mail to the spam folder instead of the inbox. Your legitimate mail is unaffected. Switch once your pass rate has been above 95% for a few days.',
    target: 'quarantine',
    color: '#d97706',
  },
  {
    title: 'Step 2 — Switch to reject',
    body: 'Reject is full enforcement: spoofed mail claiming to be from your domain is rejected outright and never reaches recipients. Only switch when you\'ve confirmed all your legitimate sending sources are passing.',
    target: 'reject',
    color: '#2563eb',
  },
];

function buildRecord(current: string | null, targetPolicy: Policy, ruaAddress: string): string {
  if (!current) return `v=DMARC1; p=${targetPolicy}; rua=mailto:${ruaAddress}`;
  let record = /p=[a-z]+/.test(current)
    ? current.replace(/p=[a-z]+/, `p=${targetPolicy}`)
    : `${current}; p=${targetPolicy}`;
  if (!record.includes(ruaAddress)) {
    record = /rua=/.test(record)
      ? record.replace(/rua=([^;]+)/, `rua=$1,mailto:${ruaAddress}`)
      : `${record}; rua=mailto:${ruaAddress}`;
  }
  return record;
}

export function DmarcWizard({ domainId, onUnauthorized }: Props) {
  const [domain, setDomain] = useState<Domain | null>(null);
  const [currentRecord, setCurrentRecord] = useState<string | null>(null);
  const [cfManaged, setCfManaged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [copied, copy] = useCopyClipboard();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [{ domains }, dns] = await Promise.all([
          getDomains(),
          checkDomainDns(domainId).catch(() => ({ found: false, has_rua: false, current_record: null, cf_managed: false })),
        ]);
        if (cancelled) return;
        const d = domains.find(d => d.id === domainId) ?? null;
        setDomain(d);
        setCurrentRecord(dns.current_record);
        setCfManaged(dns.cf_managed);
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
  if (error) return <div style={ws.wrap}><p style={{ color: '#dc2626' }}>Error: {error}</p></div>;
  if (!domain) return <div style={ws.wrap}><p style={{ color: '#9ca3af' }}>Domain not found.</p></div>;

  const policy = (domain.dmarc_policy ?? 'none') as Policy;
  const policyStep = POLICY_STEPS[policy] ?? 0;

  // Step = which upgrade step we're showing (0 = none→quarantine, 1 = quarantine→reject, 2 = done)
  const initialStep = policy === 'reject' ? 2 : policyStep;
  const [step, setStep] = useState(initialStep);

  const isFullyEnforced = policy === 'reject' || step === 2;
  const stepData = STEP_COPY[step];

  async function applyPolicy(targetPolicy: Policy) {
    setBusy(true);
    setApplyError(null);
    try {
      await updateDmarcPolicy(domainId, targetPolicy);
      const { domains } = await getDomains();
      const updated = domains.find(d => d.id === domainId);
      if (updated) setDomain(updated);
      setCurrentRecord(buildRecord(currentRecord, targetPolicy, domain!.rua_address));
      setStep(prev => prev + 1);
    } catch (e: any) {
      setApplyError(e.message ?? 'Failed to apply policy');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={ws.wrap}>
      <a href={`#/domains/${domainId}`} style={{ fontSize: '0.85rem', color: '#6b7280', textDecoration: 'none', display: 'inline-block', marginBottom: '1rem' }}>
        ← Back to domain
      </a>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.35rem', fontWeight: 700 }}>DMARC Policy Graduation</h2>
      <p style={{ ...ws.body, marginBottom: '1.5rem', color: '#6b7280' }}>
        Guided path: <strong>none</strong> → <strong>quarantine</strong> → <strong>reject</strong>
      </p>

      <StepProgress
        current={Math.min(step, 2)}
        total={3}
        labels={['None', 'Quarantine', 'Reject']}
      />

      <div style={ws.card}>
        {isFullyEnforced ? (
          <>
            <h3 style={{ ...ws.stepTitle, color: '#16a34a' }}>Fully enforced</h3>
            <p style={ws.body}>
              DMARC is set to <strong>reject</strong> — spoofed mail claiming to be from{' '}
              <strong>{domain.domain}</strong> is rejected outright by receiving servers.
            </p>
            <div style={{ padding: '0.75rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.85rem', color: '#15803d' }}>
              ✓ Nothing more to do here. Monitor your pass rate in the domain overview.
            </div>
            <a href={`#/domains/${domainId}`} style={{ ...ws.nextBtn, textDecoration: 'none', display: 'inline-block', textAlign: 'center' as const }}>
              Back to domain →
            </a>
          </>
        ) : (
          <>
            <h3 style={{ ...ws.stepTitle, color: stepData.color }}>{stepData.title}</h3>
            <p style={ws.body}>{stepData.body}</p>

            {currentRecord && (
              <div style={{ marginBottom: '0.75rem' }}>
                <div style={{ ...ws.label, marginBottom: '0.35rem' }}>Current record</div>
                <code style={{ display: 'block', fontSize: '0.78rem', fontFamily: 'monospace', color: '#6b7280', wordBreak: 'break-all' as const }}>
                  {currentRecord}
                </code>
              </div>
            )}

            <div style={{ marginBottom: '1rem' }}>
              <div style={{ ...ws.label, marginBottom: '0.35rem' }}>New record</div>
              <CodeBlock
                value={buildRecord(currentRecord, stepData.target, domain.rua_address)}
                onCopy={() => copy(buildRecord(currentRecord, stepData.target, domain.rua_address))}
                copied={copied}
              />
            </div>

            {applyError && <p style={ws.error}>{applyError}</p>}

            <div style={ws.nav}>
              {step > 0
                ? <button onClick={() => setStep(s => s - 1)} style={ws.skipLink}>← Back</button>
                : <span />
              }
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {cfManaged && (
                  <button
                    onClick={() => applyPolicy(stepData.target)}
                    disabled={busy}
                    style={{ ...ws.actionBtn, background: stepData.color, opacity: busy ? 0.6 : 1 }}
                  >
                    {busy ? 'Applying…' : `Apply via Cloudflare →`}
                  </button>
                )}
                {!cfManaged && (
                  <button onClick={() => setStep(s => s + 1)} style={ws.nextBtn}>
                    I've updated it manually →
                  </button>
                )}
              </div>
            </div>
            {!cfManaged && (
              <p style={{ fontSize: '0.78rem', color: '#9ca3af', marginTop: '0.75rem' }}>
                Copy the record above and update it in your DNS provider, then click confirm.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
