import { useState, useEffect } from 'preact/hooks';
import { getDomains, getOnboardingStatus, applyDmarc, getWizardState, updateWizardState, setupEmailRouting, setBaseDomain, registerDestination } from '../api';
import type { OnboardingStatus, WizardState, WizardStepState } from '../types';

type Severity = 'good' | 'info' | 'warning' | 'error';

const SEV_COLOR: Record<Severity, string> = {
  good: '#16a34a', info: '#2563eb', warning: '#d97706', error: '#dc2626',
};
const SEV_BG: Record<Severity, string> = {
  good: '#f0fdf4', info: '#eff6ff', warning: '#fffbeb', error: '#fef2f2',
};
const SEV_LABEL: Record<Severity, string> = {
  good: '✓ All good', info: 'ℹ Info', warning: '⚠ Needs attention', error: '✕ Action required',
};

function buildRecommendedRecord(currentRecord: string | null, targetPolicy: string, ruaAddress: string): string {
  if (!currentRecord) return `v=DMARC1; p=${targetPolicy}; rua=mailto:${ruaAddress}`;
  let record = /p=[a-z]+/.test(currentRecord)
    ? currentRecord.replace(/p=[a-z]+/, `p=${targetPolicy}`)
    : `${currentRecord}; p=${targetPolicy}`;
  if (!record.includes(ruaAddress)) {
    record = /rua=/.test(record)
      ? record.replace(/rua=([^;]+)/, `rua=$1,mailto:${ruaAddress}`)
      : `${record}; rua=mailto:${ruaAddress}`;
  }
  return record;
}

function dmarcSeverity(d: OnboardingStatus['dmarc']): Severity {
  if (!d.found) return 'error';
  if (!d.has_our_rua) return 'warning';
  return 'info';
}

function spfSeverity(s: OnboardingStatus['spf']): Severity {
  if (!s.record) return 'warning';
  const c = s.lookup_count ?? 0;
  if (c > 9) return 'error';
  if (c >= 8) return 'warning';
  return 'good';
}

function dkimSeverity(d: OnboardingStatus['dkim'], dmarcPolicy: string | null): Severity {
  if (d.selectors.length > 0) return 'good';
  if (dmarcPolicy === 'quarantine' || dmarcPolicy === 'reject') return 'warning';
  return 'info';
}

function routingSeverity(r: OnboardingStatus['routing']): Severity {
  if (r.mx_found && r.destination_verified) return 'good';
  if (r.mx_found || r.destination_verified) return 'warning';
  return 'error';
}

function Badge({ sev }: { sev: Severity }) {
  return (
    <span style={{
      display: 'inline-block',
      background: SEV_BG[sev], color: SEV_COLOR[sev],
      border: `1px solid ${SEV_COLOR[sev]}33`,
      fontSize: '0.75rem', fontWeight: 700,
      padding: '0.2rem 0.6rem', borderRadius: '4px',
    }}>
      {SEV_LABEL[sev]}
    </span>
  );
}

function CodeBlock({ value, onCopy, copied }: { value: string; onCopy: () => void; copied: boolean }) {
  return (
    <div style={{ position: 'relative', marginTop: '0.5rem' }}>
      <code style={{
        display: 'block', background: '#f3f4f6', border: '1px solid #e5e7eb',
        borderRadius: '6px', padding: '0.65rem 2.5rem 0.65rem 0.75rem',
        fontSize: '0.78rem', fontFamily: 'monospace', wordBreak: 'break-all', lineHeight: 1.5,
      }}>
        {value}
      </code>
      <button
        onClick={onCopy}
        style={{
          position: 'absolute', top: '0.4rem', right: '0.4rem',
          background: '#e5e7eb', border: 'none', borderRadius: '4px',
          fontSize: '0.7rem', padding: '0.2rem 0.45rem', cursor: 'pointer', color: '#374151',
        }}
      >
        {copied ? '✓' : 'Copy'}
      </button>
    </div>
  );
}

function StepProgress({ current, total, wizardState }: { current: number; total: number; wizardState: WizardState }) {
  const stepKeys: (keyof WizardState)[] = ['domain', 'spf', 'dkim', 'dmarc', 'routing'];
  return (
    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '1.5rem' }}>
      {Array.from({ length: total }, (_, i) => {
        const state = wizardState[stepKeys[i]];
        const bg = state === 'complete' ? '#16a34a'
          : state === 'skipped' ? '#d97706'
          : i === current ? '#111827'
          : '#d1d5db';
        return (
          <div key={i} style={{
            width: i === current ? '1.5rem' : '0.5rem',
            height: '0.5rem', borderRadius: '999px',
            background: bg,
            transition: 'all 0.2s',
          }} />
        );
      })}
      <span style={{ marginLeft: '0.25rem', fontSize: '0.75rem', color: '#9ca3af' }}>
        {current + 1} / {total}
      </span>
    </div>
  );
}

// ── Step nav with skip ───────────────────────────────────────────────────────

interface StepNavProps {
  onNext: () => void;
  onSkip: () => void;
  nextLabel?: string;
  showSkip?: boolean;
}

function StepNav({ onNext, onSkip, nextLabel = 'Continue →', showSkip = true }: StepNavProps) {
  return (
    <div style={{ ...s.nav, justifyContent: 'space-between' }}>
      {showSkip ? (
        <button onClick={onSkip} style={s.skipStepBtn}>Skip for now</button>
      ) : <span />}
      <button onClick={onNext} style={s.nextBtn}>{nextLabel}</button>
    </div>
  );
}

// ── Step components ───────────────────────────────────────────────────────────

function DomainStep({ onDomainSet }: { onDomainSet: (domainId: number) => void }) {
  const [domain, setDomain] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const d = domain.toLowerCase().trim();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
      setError('Enter a valid domain like yourdomain.com');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await setBaseDomain(d);
      onDomainSet(result.domain_id);
    } catch (e: any) {
      setError(e.message ?? 'Failed to set domain');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h2 style={s.stepTitle}>What's your domain?</h2>
      <p style={{ ...s.body, marginTop: '0.5rem' }}>
        Enter the domain you want to monitor. InboxAngel will check its SPF, DKIM, and DMARC
        records and collect aggregate reports.
      </p>
      <div style={{ marginTop: '1rem' }}>
        <input
          type="text"
          placeholder="yourdomain.com"
          value={domain}
          onInput={e => setDomain((e.target as HTMLInputElement).value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          style={{
            width: '100%', padding: '0.65rem 0.75rem',
            border: '1.5px solid #d1d5db', borderRadius: '6px',
            fontSize: '0.95rem', fontFamily: 'inherit', outline: 'none',
            boxSizing: 'border-box',
          }}
          autoFocus
        />
      </div>
      {error && <p style={s.error}>{error}</p>}
      <div style={{ ...s.nav, marginTop: '1.5rem' }}>
        <span />
        <button
          onClick={submit}
          disabled={submitting || !domain.trim()}
          style={{ ...s.nextBtn, opacity: submitting || !domain.trim() ? 0.6 : 1 }}
        >
          {submitting ? 'Setting up…' : 'Continue →'}
        </button>
      </div>
    </div>
  );
}

function SpfStep({ status, onNext, onSkip }: { status: OnboardingStatus; onNext: () => void; onSkip: () => void }) {
  const { spf } = status;
  const sev = spfSeverity(spf);
  const [copied, setCopied] = useState(false);

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const count = spf.lookup_count ?? 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
        <Badge sev={sev} />
        <h2 style={s.stepTitle}>SPF record</h2>
      </div>

      {spf.record ? (
        <div style={{ marginBottom: '0.75rem' }}>
          <p style={s.label}>Current record</p>
          <CodeBlock value={spf.record} onCopy={() => copy(spf.record!)} copied={copied} />
          {spf.lookup_count !== null && (
            <p style={{ ...s.body, marginTop: '0.4rem' }}>
              DNS lookup depth: <strong style={{ color: SEV_COLOR[sev] }}>{count} / 10</strong>
              {count > 9 && ' — over the limit, receiving servers may reject your mail'}
              {count >= 8 && count <= 9 && ' — getting close to the limit'}
              {count < 8 && ' — healthy'}
            </p>
          )}
          {count > 9 && (
            <p style={{ ...s.body, color: '#d97706', fontSize: '0.8rem', marginTop: '0.4rem' }}>
              You're over the 10-lookup RFC limit. Check the domain detail page after setup for flattening options.
            </p>
          )}
        </div>
      ) : (
        <>
          <p style={s.body}>No SPF record found. Without SPF, any server can claim to send email as you.</p>
          <p style={s.body}>
            Create one with your email provider's instructions, then return here. A basic example:
            <br />
            <code style={s.inline}>v=spf1 include:_spf.google.com ~all</code>
          </p>
        </>
      )}

      {sev === 'good' && (
        <p style={s.body}>
          Your SPF record is healthy. InboxAngel monitors it daily and will alert you if lookup depth increases.
        </p>
      )}

      <StepNav onNext={onNext} onSkip={onSkip} showSkip={sev !== 'good'} />
    </div>
  );
}

function DkimStep({ status, onNext, onSkip }: { status: OnboardingStatus; onNext: () => void; onSkip: () => void }) {
  const { dkim } = status;
  const dmarcPolicy = status.dmarc.current_record?.match(/p=([a-z]+)/)?.[1] ?? null;
  const sev = dkimSeverity(dkim, dmarcPolicy);
  const [rescanning, setRescanning] = useState(false);
  const [rescanStatus, setRescanStatus] = useState<OnboardingStatus | null>(null);

  const currentDkim = rescanStatus?.dkim ?? dkim;
  const currentSev = rescanStatus ? dkimSeverity(rescanStatus.dkim, dmarcPolicy) : sev;

  const rescan = async () => {
    setRescanning(true);
    try {
      const updated = await getOnboardingStatus(status.domain_id);
      setRescanStatus(updated);
    } catch {} finally {
      setRescanning(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
        <Badge sev={currentSev} />
        <h2 style={s.stepTitle}>DKIM signing</h2>
      </div>

      {currentDkim.selectors.length > 0 ? (
        <>
          <p style={s.body}>
            Found {currentDkim.selectors.length} DKIM selector{currentDkim.selectors.length > 1 ? 's' : ''}.
            Your email provider has configured signing — outgoing mail carries a cryptographic signature.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.5rem' }}>
            {currentDkim.selectors.map(sel => (
              <div key={sel.name} style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', padding: '0.4rem 0.75rem' }}>
                <code style={{ fontSize: '0.78rem', color: '#15803d', fontFamily: 'monospace' }}>{sel.name}</code>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <p style={s.body}>
            No DKIM selectors found{currentDkim.source === 'doh' ? ' (checked common selectors)' : ''}.
          </p>
          {currentSev === 'warning' ? (
            <p style={s.body}>
              Your DMARC policy is <code style={s.inline}>p={dmarcPolicy}</code> but emails lack DKIM signatures.
              Without DKIM, some messages may fail DMARC alignment and get quarantined or rejected.
              Set up DKIM signing with your email provider before tightening your policy further.
            </p>
          ) : (
            <p style={s.body}>
              DKIM isn't required right now since DMARC is in monitoring mode, but you'll need it before
              moving to <code style={s.inline}>p=quarantine</code> or <code style={s.inline}>p=reject</code>.
              Set it up through your email provider (Google Workspace, Microsoft 365, etc.).
            </p>
          )}
        </>
      )}

      <p style={{ ...s.body, color: '#9ca3af', fontSize: '0.8rem', marginTop: '0.75rem' }}>
        DKIM keys are generated inside your email provider's dashboard, not in DNS directly.
        Once configured there, click "Rescan DNS" to verify.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
        <button onClick={rescan} disabled={rescanning} style={{ ...s.secondaryBtn, opacity: rescanning ? 0.6 : 1 }}>
          {rescanning ? 'Scanning…' : 'Rescan DNS'}
        </button>
      </div>

      <StepNav onNext={onNext} onSkip={onSkip} showSkip={currentDkim.selectors.length === 0} />
    </div>
  );
}

function DmarcStep({ status, onNext, onSkip }: { status: OnboardingStatus; onNext: () => void; onSkip: () => void }) {
  const { dmarc, cf_available } = status;
  const sev = dmarcSeverity(dmarc);
  const [copied, setCopied] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const recommended = buildRecommendedRecord(dmarc.current_record, 'none', dmarc.rua_address);

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      await applyDmarc(status.domain_id, recommended);
      setApplied(true);
    } catch (e: any) {
      setApplyError(e.message ?? 'Failed to apply');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
        <Badge sev={applied ? 'info' : sev} />
        <h2 style={s.stepTitle}>DMARC policy</h2>
      </div>

      {dmarc.current_record ? (
        <div style={{ marginBottom: '0.75rem' }}>
          <p style={s.label}>Current record</p>
          <CodeBlock value={dmarc.current_record} onCopy={() => copy(dmarc.current_record!)} copied={copied} />
        </div>
      ) : (
        <p style={s.body}>No DMARC record found for <strong>_dmarc.{status.domain}</strong>.</p>
      )}

      {sev === 'error' && (
        <p style={s.body}>
          Without a DMARC record, receiving mail servers won't send reports — InboxAngel has nothing to analyze.
          Create one pointing to <code style={s.inline}>p=none</code> (monitor-only) so reports start flowing.
        </p>
      )}
      {sev === 'warning' && (
        <p style={s.body}>
          Your DMARC record exists but isn't sending reports to InboxAngel.
          Add <code style={s.inline}>rua=mailto:{dmarc.rua_address}</code> to start receiving aggregate reports.
        </p>
      )}
      {(sev === 'info' || applied) && (
        <p style={s.body}>
          Reports will start arriving within 24 hours. Once you have data, the dashboard will guide you
          from <code style={s.inline}>p=none</code> to <code style={s.inline}>p=reject</code> safely.
        </p>
      )}

      {(sev === 'error' || sev === 'warning') && !applied && (
        <div style={{ marginTop: '0.75rem' }}>
          <p style={s.label}>Recommended record</p>
          <CodeBlock value={recommended} onCopy={() => copy(recommended)} copied={copied} />
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
            {cf_available && (
              <button
                onClick={apply}
                disabled={applying}
                style={{ ...s.actionBtn, background: SEV_COLOR[sev], opacity: applying ? 0.6 : 1 }}
              >
                {applying ? 'Applying…' : 'Apply via Cloudflare'}
              </button>
            )}
            <button onClick={() => copy(recommended)} style={s.secondaryBtn}>
              {copied ? '✓ Copied' : 'Copy record'}
            </button>
          </div>
          {applyError && <p style={s.error}>{applyError}</p>}
        </div>
      )}

      <StepNav
        onNext={onNext}
        onSkip={onSkip}
        showSkip={sev !== 'info' && !applied}
      />
    </div>
  );
}

function RoutingStep({ status, onDone, onSkip }: { status: OnboardingStatus; onDone: () => void; onSkip: () => void }) {
  const { routing } = status;
  const sev = routingSeverity(routing);
  const [rechecking, setRechecking] = useState(false);
  const [recheckResult, setRecheckResult] = useState<OnboardingStatus['routing'] | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupInfo, setSetupInfo] = useState<string | null>(null);

  const current = recheckResult ?? routing;
  const currentSev = recheckResult ? routingSeverity(recheckResult) : sev;

  const recheck = async () => {
    setRechecking(true);
    try {
      const updated = await getOnboardingStatus(status.domain_id);
      setRecheckResult(updated.routing);
    } catch {} finally {
      setRechecking(false);
    }
  };

  const setup = async () => {
    setSettingUp(true);
    setSetupError(null);
    setSetupInfo(null);
    try {
      const result = await setupEmailRouting();
      if (result.status === 'already_configured') {
        setSetupInfo('Email routing is already configured. MX records may take a few minutes to propagate — try re-checking shortly.');
      } else if (result.status === 'newly_configured') {
        setSetupInfo('Email routing configured successfully! MX records created and catch-all rule set.');
      }
      await recheck();
    } catch (e: any) {
      setSetupError(e.message ?? 'Failed to set up email routing');
    } finally {
      setSettingUp(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
        <Badge sev={currentSev} />
        <h2 style={s.stepTitle}>Reports routing</h2>
      </div>

      {/* MX records */}
      <div style={{ marginBottom: '0.75rem' }}>
        <p style={s.label}>MX records</p>
        {current.mx_found ? (
          <p style={s.body}>
            MX records found for <code style={s.inline}>{current.reports_domain}</code> — reports can reach InboxAngel.
          </p>
        ) : (
          <>
            <p style={s.body}>
              No MX records found for <code style={s.inline}>{current.reports_domain ?? 'your reports domain'}</code>.
              Email routing needs to be configured so DMARC reports can reach InboxAngel.
            </p>
            <p style={{ ...s.body, fontSize: '0.85rem', color: '#6b7280', marginTop: '0.25rem' }}>
              This will: create MX records for your reports subdomain and set a catch-all email routing rule
              that forwards incoming DMARC reports to the InboxAngel worker.
            </p>
            <button
              onClick={setup}
              disabled={settingUp}
              style={{ ...s.actionBtn, background: '#d97706', opacity: settingUp ? 0.6 : 1 }}
            >
              {settingUp ? 'Setting up…' : 'Set up email routing'}
            </button>
            {setupError && <p style={s.error}>{setupError}</p>}
            {setupInfo && <p style={{ ...s.body, color: '#059669', fontSize: '0.9rem', marginTop: '0.5rem' }}>{setupInfo}</p>}
          </>
        )}
      </div>

      {/* Destination verification */}
      <div style={{ marginBottom: '0.75rem' }}>
        <p style={s.label}>Email destination</p>
        {current.destination_verified ? (
          <p style={s.body}>
            <code style={s.inline}>{current.admin_email}</code> is verified as a Cloudflare Email Routing destination. Alerts and password resets will work.
          </p>
        ) : (
          <>
            <p style={s.body}>
              <code style={s.inline}>{current.admin_email ?? 'Your email'}</code> needs to be registered as a Cloudflare Email Routing destination
              so InboxAngel can send you alerts and password reset emails.
            </p>
            <button
              onClick={async () => {
                setSettingUp(true);
                setSetupError(null);
                try {
                  await registerDestination();
                  setSetupInfo('Verification email sent! Check your inbox and click the link from Cloudflare, then press "Re-check".');
                } catch (e: any) {
                  setSetupError(e.message ?? 'Failed to register destination');
                } finally {
                  setSettingUp(false);
                }
              }}
              disabled={settingUp}
              style={{ ...s.actionBtn, background: '#2563eb', opacity: settingUp ? 0.6 : 1, marginTop: '0.5rem' }}
            >
              {settingUp ? 'Registering…' : 'Register email destination'}
            </button>
            {current.destination_debug && (
              <p style={{ ...s.body, fontSize: '0.8rem', color: '#9ca3af', marginTop: '0.25rem' }}>
                Debug: {current.destination_debug}
              </p>
            )}
          </>
        )}
      </div>

      {currentSev === 'good' ? (
        <p style={s.body}>
          Everything is connected. Reports arrive within 24 hours of your first mail flows.
        </p>
      ) : (
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
          <button onClick={recheck} disabled={rechecking} style={{ ...s.secondaryBtn, opacity: rechecking ? 0.6 : 1 }}>
            {rechecking ? 'Checking…' : 'Re-check'}
          </button>
        </div>
      )}

      <StepNav
        onNext={onDone}
        onSkip={onSkip}
        nextLabel="Go to dashboard →"
        showSkip={currentSev !== 'good'}
      />
    </div>
  );
}

// ── Main wizard ───────────────────────────────────────────────────────────────

const STEPS = ['Domain', 'SPF', 'DKIM', 'DMARC', 'Routing'];
const STEP_KEYS: (keyof WizardState)[] = ['domain', 'spf', 'dkim', 'dmarc', 'routing'];
const DEFAULT_WIZARD: WizardState = { domain: 'not_started', spf: 'not_started', dkim: 'not_started', dmarc: 'not_started', routing: 'not_started' };

export function Onboarding({ domainId: domainIdProp, initialStep }: { domainId?: number; initialStep?: number } = {}) {
  // Steps are 1-indexed in the URL, 0-indexed internally
  const initialInternal = initialStep !== undefined ? initialStep - 1 : undefined;
  const [step, setStepRaw] = useState(initialInternal ?? 0);
  const [domainId, setDomainId] = useState<number | null>(domainIdProp ?? null);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [wizardState, setWizardState] = useState<WizardState>(DEFAULT_WIZARD);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // True when we're on the domain step (step 0) and no domain is set yet
  const [needsDomain, setNeedsDomain] = useState(false);

  const setStep = (s: number | ((prev: number) => number)) => {
    setStepRaw(prev => {
      const next = typeof s === 'function' ? s(prev) : s;
      if (domainId) {
        window.location.hash = `#/domains/${domainId}/setup/${next + 1}`;
      }
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let id = domainIdProp ?? null;
        if (!id) {
          // No domain ID in URL — check if any domain exists
          const { domains } = await getDomains();
          if (domains.length === 0) {
            // No domain yet — show domain step
            setNeedsDomain(true);
            setLoading(false);
            return;
          }
          id = domains[0].id;
          // Redirect to proper URL
          window.location.hash = `#/domains/${id}/setup/1`;
          return;
        }
        setDomainId(id);

        const [statusData, wizardData] = await Promise.all([
          getOnboardingStatus(id),
          getWizardState(id).catch(() => DEFAULT_WIZARD),
        ]);

        if (cancelled) return;
        setStatus(statusData);
        setWizardState(wizardData);

        // Jump to first incomplete step on resume (unless URL specified a step)
        // Skip step 0 (domain) if domain is already set
        if (initialStep === undefined) {
          const firstIncomplete = STEP_KEYS.findIndex((k, i) => {
            if (i === 0) return false; // domain step is done if we got here
            return wizardData[k] === 'not_started';
          });
          const target = firstIncomplete > 0 ? firstIncomplete : 1; // skip domain step
          if (target > 0) {
            setStepRaw(target);
            window.location.hash = `#/domains/${id}/setup/${target + 1}`;
          }
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const done = () => {
    localStorage.setItem('ia_onboarding_done', '1');
    const id = domainId ?? domainIdProp;
    window.location.hash = id ? `#/domains/${id}` : '#/';
  };

  // Called when domain step completes — sets up domain and loads onboarding status
  const handleDomainSet = async (newDomainId: number) => {
    setDomainId(newDomainId);
    setNeedsDomain(false);

    // Mark domain step as complete
    const updated = { ...wizardState, domain: 'complete' as WizardStepState };
    setWizardState(updated);
    updateWizardState(newDomainId, { domain: 'complete' }).catch(() => {});

    // Load onboarding status for the new domain
    try {
      const statusData = await getOnboardingStatus(newDomainId);
      setStatus(statusData);
      // Advance to step 1 (SPF)
      setStepRaw(1);
      window.location.hash = `#/domains/${newDomainId}/setup/2`;
    } catch (e: any) {
      setError(e.message ?? 'Failed to load domain status');
    }
  };

  const markAndAdvance = async (state: WizardStepState) => {
    const key = STEP_KEYS[step];
    const updates = { [key]: state } as Partial<WizardState>;
    const updated = { ...wizardState, [key]: state };
    setWizardState(updated);

    if (domainId) {
      updateWizardState(domainId, updates).catch(() => {});
    }

    if (step < STEPS.length - 1) {
      setStep(s => s + 1);
    } else {
      done();
    }
  };

  const handleNext = () => markAndAdvance('complete');
  const handleSkip = () => markAndAdvance('skipped');

  const completedCount = STEP_KEYS.filter(k => wizardState[k] === 'complete').length;

  if (loading) return (
    <div style={s.wrap}>
      <div style={s.card}><p style={{ color: '#9ca3af', margin: 0 }}>Loading…</p></div>
    </div>
  );

  // Domain step — shown when no domain exists yet
  if (needsDomain) {
    return (
      <div style={s.wrap}>
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <div style={s.logo}>InboxAngel</div>
            <button onClick={done} style={s.skipLink}>Skip setup →</button>
          </div>
          <p style={{ ...s.body, margin: '0 0 0.25rem', color: '#6b7280' }}>
            Let's get your email security set up
          </p>
          <p style={{ margin: '0 0 1.25rem', fontSize: '0.75rem', color: '#9ca3af' }}>
            Step 1 of {STEPS.length}
          </p>
          <StepProgress current={0} total={STEPS.length} wizardState={wizardState} />
          <DomainStep onDomainSet={handleDomainSet} />
        </div>
      </div>
    );
  }

  if (error || !status) return (
    <div style={s.wrap}>
      <div style={s.card}>
        <p style={{ color: '#dc2626', margin: 0 }}>{error ?? 'Could not load domain status.'}</p>
        <button onClick={done} style={{ ...s.nextBtn, marginTop: '1rem' }}>Go to dashboard →</button>
      </div>
    </div>
  );

  return (
    <div style={s.wrap}>
      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <div style={s.logo}>InboxAngel</div>
          <button onClick={done} style={s.skipLink}>Skip setup →</button>
        </div>
        <p style={{ ...s.body, margin: '0 0 0.25rem', color: '#6b7280' }}>
          Let's verify your email security for <strong>{status.domain}</strong>
        </p>
        <p style={{ margin: '0 0 1.25rem', fontSize: '0.75rem', color: '#9ca3af' }}>
          {completedCount} of {STEPS.length} steps complete
        </p>

        <StepProgress current={step} total={STEPS.length} wizardState={wizardState} />

        {step === 0 && <DomainStep onDomainSet={handleDomainSet} />}
        {step === 1 && <SpfStep status={status} onNext={handleNext} onSkip={handleSkip} />}
        {step === 2 && <DkimStep status={status} onNext={handleNext} onSkip={handleSkip} />}
        {step === 3 && <DmarcStep status={status} onNext={handleNext} onSkip={handleSkip} />}
        {step === 4 && <RoutingStep status={status} onDone={handleNext} onSkip={handleSkip} />}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = {
  wrap: {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#f9fafb', padding: '2rem 1rem',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  } as const,
  card: {
    width: '100%', maxWidth: '480px', background: '#fff',
    borderRadius: '12px', boxShadow: '0 1px 6px rgba(0,0,0,0.1)',
    padding: '2rem',
  } as const,
  logo: { fontSize: '1rem', fontWeight: 700, color: '#111827' } as const,
  stepTitle: { margin: 0, fontSize: '1.15rem', fontWeight: 700, letterSpacing: '-0.01em' } as const,
  label: { margin: '0 0 0.2rem', fontSize: '0.75rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  body: { margin: '0 0 0.5rem', fontSize: '0.875rem', color: '#374151', lineHeight: 1.55 } as const,
  inline: {
    fontFamily: 'monospace', fontSize: '0.85em',
    background: '#f3f4f6', padding: '0.1em 0.3em', borderRadius: '3px',
  } as const,
  nav: { marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end', alignItems: 'center' } as const,
  nextBtn: {
    padding: '0.6rem 1.25rem', background: '#111827', color: '#fff',
    border: 'none', borderRadius: '8px', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer',
  } as const,
  actionBtn: {
    padding: '0.55rem 1rem', color: '#fff',
    border: 'none', borderRadius: '7px', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
  } as const,
  secondaryBtn: {
    padding: '0.55rem 1rem', background: '#f3f4f6', color: '#374151',
    border: '1px solid #d1d5db', borderRadius: '7px', fontSize: '0.875rem', cursor: 'pointer',
  } as const,
  skipLink: {
    background: 'none', border: 'none', padding: 0,
    fontSize: '0.8rem', color: '#9ca3af', cursor: 'pointer', textDecoration: 'underline',
  } as const,
  skipStepBtn: {
    background: 'none', border: 'none', padding: '0.6rem 0',
    fontSize: '0.8rem', color: '#9ca3af', cursor: 'pointer', textDecoration: 'underline',
  } as const,
  error: { color: '#dc2626', fontSize: '0.8rem', margin: '0.4rem 0 0' } as const,
};
