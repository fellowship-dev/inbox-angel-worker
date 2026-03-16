import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { getDomains, getOnboardingStatus, applyDmarc, applySpf, getSpfLookupCount, getWizardState, updateWizardState, setupEmailRouting, setBaseDomain, registerDestination } from '../api';
import { SPF_PROVIDERS, detectProviders, extractIncludes, extractOtherMechanisms, buildSpfRecord, matchDkimProvider, findUnsignedSpfProviders } from '../email-service-providers';
import type { EmailProvider } from '../email-service-providers';
import type { OnboardingStatus, WizardState, WizardStepState } from '../types';
import { type Severity, SEV_COLOR, SEV_BG, SEV_LABEL } from '../components/WizardKit';

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

function dkimSeverity(d: OnboardingStatus['dkim'], dmarcPolicy: string | null, unsignedCount = 0): Severity {
  const hasDkim = d.selectors.length > 0;
  const strict = dmarcPolicy === 'quarantine' || dmarcPolicy === 'reject';
  if (hasDkim && unsignedCount === 0) return 'good';
  if (hasDkim && unsignedCount > 0 && strict) return 'warning';
  if (hasDkim && unsignedCount > 0) return 'info';
  if (!hasDkim && strict) return 'warning';
  return 'info';
}

function routingSeverity(r: OnboardingStatus['routing']): Severity {
  const allGood = r.mx_found && r.destination_verified && r.null_sender_spf && r.null_sender_dmarc;
  if (allGood) return 'good';
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
        Enter the domain you send email from. We'll check its current security
        settings and walk you through any improvements.
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

function ProviderTypeahead({ selected, onAdd, customInclude, onCustomChange, onCustomAdd }: {
  selected: Set<string>;
  onAdd: (include: string) => void;
  customInclude: string;
  onCustomChange: (v: string) => void;
  onCustomAdd: () => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const filtered = query.trim()
    ? SPF_PROVIDERS.filter(p =>
        !selected.has(p.include) &&
        (p.name.toLowerCase().includes(query.toLowerCase()) || p.include.toLowerCase().includes(query.toLowerCase()))
      )
    : SPF_PROVIDERS.filter(p => !selected.has(p.include));

  const handleSelect = (include: string) => {
    onAdd(include);
    setQuery('');
    setOpen(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && filtered.length > 0) {
      e.preventDefault();
      handleSelect(filtered[0].include);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div style={{ position: 'relative', marginTop: '0.3rem' }}>
      <div style={{ display: 'flex', gap: '0.4rem' }}>
        <input
          type="text"
          value={query || customInclude}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            setQuery(v);
            onCustomChange(v);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          onKeyDown={handleKeyDown}
          placeholder="Search providers or type custom domain…"
          style={{ flex: 1, padding: '0.45rem 0.6rem', fontSize: '0.82rem', border: '1px solid #d1d5db', borderRadius: '6px' }}
        />
        {customInclude.trim() && !SPF_PROVIDERS.some(p => p.include === customInclude.trim().toLowerCase()) && (
          <button onClick={() => { onCustomAdd(); setQuery(''); }} style={{ ...s.secondaryBtn, padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}>
            Add custom
          </button>
        )}
      </div>
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
          background: '#fff', border: '1px solid #d1d5db', borderRadius: '6px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxHeight: '180px', overflowY: 'auto',
          marginTop: '2px',
        }}>
          {filtered.map(p => (
            <div
              key={p.include}
              onMouseDown={() => handleSelect(p.include)}
              style={{
                padding: '0.4rem 0.6rem', cursor: 'pointer', fontSize: '0.82rem',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderBottom: '1px solid #f3f4f6',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f9fafb')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ color: '#374151' }}>{p.name}</span>
              <code style={{ fontSize: '0.7rem', color: '#9ca3af' }}>{p.include}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SpfStep({ status, onNext, onSkip }: { status: OnboardingStatus; onNext: () => void; onSkip: () => void }) {
  const { spf, cf_available } = status;
  const sev = spfSeverity(spf);
  const [copied, setCopied] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [customInclude, setCustomInclude] = useState('');

  // Detect existing providers and unknown includes from current record
  const existingIncludes = spf.record ? extractIncludes(spf.record) : [];
  const detectedProviders = spf.record ? detectProviders(spf.record) : [];
  const detectedIncludeSet = new Set(detectedProviders.map(p => p.include));
  const unknownIncludes = existingIncludes.filter(i => !SPF_PROVIDERS.some(p => p.include === i));
  // Preserve non-include mechanisms (mx, a, ip4:, ip6:, redirect=, etc.)
  const otherMechanisms = spf.record ? extractOtherMechanisms(spf.record) : [];

  // Checkbox state: provider include domain → checked
  const [selected, setSelected] = useState<Set<string>>(() => new Set(existingIncludes));
  // Track qualifier from existing record
  const existingQualifier = spf.record?.includes('-all') ? '-all' as const : '~all' as const;
  const [qualifier, setQualifier] = useState<'~all' | '-all'>(existingQualifier);

  const toggleProvider = (include: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(include)) next.delete(include);
      else next.add(include);
      return next;
    });
  };

  const addCustom = () => {
    const trimmed = customInclude.trim().toLowerCase();
    if (trimmed && !selected.has(trimmed)) {
      setSelected(prev => new Set([...prev, trimmed]));
      setCustomInclude('');
    }
  };

  const removeInclude = (include: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.delete(include);
      return next;
    });
  };

  // Build preview record from selections (preserving non-include mechanisms like mx)
  const selectedIncludes = Array.from(selected);
  const previewRecord = (selectedIncludes.length > 0 || otherMechanisms.length > 0)
    ? buildSpfRecord(selectedIncludes, qualifier, otherMechanisms)
    : null;

  // Real lookup count via backend (walks nested includes via DNS)
  const [realLookupCount, setRealLookupCount] = useState<number | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!previewRecord) { setRealLookupCount(null); return; }
    setLookupLoading(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      getSpfLookupCount(previewRecord)
        .then(r => setRealLookupCount(r.lookup_count))
        .catch(() => setRealLookupCount(null))
        .finally(() => setLookupLoading(false));
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [previewRecord]);

  const estimatedLookups = realLookupCount ?? selectedIncludes.length;

  const hasChanges = previewRecord !== spf.record;
  const flatteningActive = spf.flattening_active;

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const apply = async (confirmOverwrite = false) => {
    if (!previewRecord) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applySpf(status.domain_id, previewRecord, confirmOverwrite);
      if (result.needs_confirmation) {
        // Existing record differs — ask user to confirm overwrite
        const ok = window.confirm(
          `An existing SPF record was found in DNS:\n\n${result.existing_record}\n\nReplace it with:\n\n${result.proposed_record}\n\nProceed?`
        );
        if (ok) {
          await apply(true);
        } else {
          setApplying(false);
        }
        return;
      }
      setApplied(true);
    } catch (e: any) {
      setApplyError(e.message ?? 'Failed to apply');
    } finally {
      setApplying(false);
    }
  };

  const count = spf.lookup_count ?? 0;

  // If flattening is active, show read-only view
  if (flatteningActive) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <Badge sev="info" />
          <h2 style={s.stepTitle}>SPF record</h2>
        </div>
        {spf.record && (
          <div style={{ marginBottom: '0.75rem' }}>
            <p style={s.label}>Current record</p>
            <CodeBlock value={spf.record} onCopy={() => copy(spf.record!)} copied={copied} />
          </div>
        )}
        <p style={{ ...s.body, color: '#7c3aed', fontSize: '0.85rem' }}>
          SPF flattening is active for this domain. Editing is disabled — changes would be overwritten
          by the next flattening run. Disable flattening on the domain detail page to edit manually.
        </p>
        <StepNav onNext={onNext} onSkip={onSkip} showSkip={false} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
        <Badge sev={applied ? 'info' : sev} />
        <h2 style={s.stepTitle}>SPF record</h2>
      </div>

      {!applied && (
        <p style={{ ...s.body, marginBottom: '0.5rem' }}>
          {spf.record
            ? 'SPF tells receiving mail servers which services are allowed to send email on your behalf. Select the providers you use below — we auto-detected what you have.'
            : 'No SPF record found. Without SPF, any server can claim to send email as you. Select your email providers below to create one.'}
        </p>
      )}

      {applied ? (
        <p style={s.body}>
          SPF record applied successfully. Allow a few minutes for DNS propagation.
        </p>
      ) : (
        <>
          {/* Provider typeahead select */}
          <p style={{ ...s.label, marginTop: '0.75rem' }}>Add email providers</p>
          <ProviderTypeahead
            selected={selected}
            onAdd={(include) => setSelected(prev => new Set([...prev, include]))}
            customInclude={customInclude}
            onCustomChange={setCustomInclude}
            onCustomAdd={addCustom}
          />

          {/* Selected providers as removable chips */}
          {selectedIncludes.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.5rem' }}>
              {selectedIncludes.map(inc => {
                const provider = SPF_PROVIDERS.find(p => p.include === inc);
                const isDetected = detectedIncludeSet.has(inc);
                return (
                  <span key={inc} style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                    background: isDetected ? '#eff6ff' : '#f3f4f6', border: `1px solid ${isDetected ? '#bfdbfe' : '#e5e7eb'}`,
                    borderRadius: '999px', padding: '0.2rem 0.55rem', fontSize: '0.78rem', color: '#374151',
                  }}>
                    {provider ? provider.name : <code style={{ fontSize: '0.75rem' }}>{inc}</code>}
                    {isDetected && <span style={{ fontSize: '0.65rem', color: '#93c5fd' }}>current</span>}
                    <button onClick={() => removeInclude(inc)} style={{
                      background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer',
                      fontSize: '0.85rem', padding: '0', lineHeight: 1, marginLeft: '0.1rem',
                    }}>×</button>
                  </span>
                );
              })}
            </div>
          )}

          {/* Qualifier toggle */}
          <div style={{ marginTop: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#6b7280' }}>Qualifier:</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.82rem', color: '#374151', cursor: 'pointer' }}>
              <input type="radio" name="qualifier" checked={qualifier === '~all'} onChange={() => setQualifier('~all')} style={{ margin: 0 }} />
              ~all <span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>(softfail)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.82rem', color: '#374151', cursor: 'pointer' }}>
              <input type="radio" name="qualifier" checked={qualifier === '-all'} onChange={() => setQualifier('-all')} style={{ margin: 0 }} />
              -all <span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>(hardfail)</span>
            </label>
          </div>

          {/* Before / After comparison */}
          {previewRecord && (
            <div style={{ marginTop: '0.75rem' }}>
              {spf.record && hasChanges ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <div>
                    <p style={{ ...s.label, color: '#9ca3af' }}>Current DNS record</p>
                    <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.75rem', wordBreak: 'break-all' as const, color: '#6b7280' }}>
                      {spf.record}
                    </div>
                    {spf.lookup_count !== null && (
                      <p style={{ fontSize: '0.72rem', color: SEV_COLOR[sev], marginTop: '0.3rem' }}>
                        {count} / 10 lookups
                      </p>
                    )}
                  </div>
                  <div>
                    <p style={{ ...s.label, color: '#059669' }}>Proposed record</p>
                    <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.75rem', wordBreak: 'break-all' as const, color: '#166534' }}>
                      {previewRecord}
                    </div>
                    <p style={{ fontSize: '0.72rem', color: lookupLoading ? '#9ca3af' : estimatedLookups > 9 ? '#dc2626' : estimatedLookups >= 8 ? '#d97706' : '#059669', marginTop: '0.3rem' }}>
                      {lookupLoading ? 'counting lookups…' : `${realLookupCount !== null ? '' : '~'}${estimatedLookups} / 10 lookups`}
                    </p>
                  </div>
                </div>
              ) : (
                <div>
                  <p style={s.label}>
                    {spf.record && !hasChanges ? 'Current record' : 'Preview'}
                    <span style={{ fontWeight: 400, textTransform: 'none' as const, marginLeft: '0.5rem', color: lookupLoading ? '#9ca3af' : estimatedLookups > 9 ? '#dc2626' : estimatedLookups >= 8 ? '#d97706' : '#6b7280' }}>
                      {lookupLoading ? 'counting…' : `${realLookupCount !== null ? '' : '~'}${estimatedLookups} / 10 lookups`}
                    </span>
                  </p>
                  <CodeBlock value={previewRecord} onCopy={() => copy(previewRecord)} copied={copied} />
                </div>
              )}
              {estimatedLookups > 10 && (
                <p style={{ ...s.body, color: '#dc2626', fontSize: '0.8rem', marginTop: '0.4rem' }}>
                  This exceeds the 10-lookup RFC limit. Consider removing providers you don't use, or enable SPF flattening after setup.
                </p>
              )}
            </div>
          )}

          {/* Action buttons */}
          {previewRecord && hasChanges && (
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
              {cf_available && (
                <button
                  onClick={() => apply()}
                  disabled={applying}
                  style={{ ...s.actionBtn, background: SEV_COLOR[sev === 'good' ? 'info' : sev], opacity: applying ? 0.6 : 1 }}
                >
                  {applying ? 'Applying…' : 'Apply via Cloudflare'}
                </button>
              )}
              <button onClick={() => copy(previewRecord)} style={s.secondaryBtn}>
                {copied ? '✓ Copied' : 'Copy record'}
              </button>
            </div>
          )}
          {applyError && <p style={s.error}>{applyError}</p>}
        </>
      )}

      {sev === 'good' && !applied && !hasChanges && (
        <p style={{ ...s.body, marginTop: '0.5rem' }}>
          Your SPF record is healthy. InboxAngel monitors it daily and will alert you if lookup depth increases.
        </p>
      )}

      <StepNav onNext={onNext} onSkip={onSkip} showSkip={sev !== 'good' && !applied} />
    </div>
  );
}

function DkimStep({ status, onNext, onSkip }: { status: OnboardingStatus; onNext: () => void; onSkip: () => void }) {
  const { dkim } = status;
  const dmarcPolicy = status.dmarc.current_record?.match(/p=([a-z]+)/)?.[1] ?? null;
  const spfRecord = status.spf.record;
  const [rescanning, setRescanning] = useState(false);
  const [rescanStatus, setRescanStatus] = useState<OnboardingStatus | null>(null);

  const currentDkim = rescanStatus?.dkim ?? dkim;
  const currentSpf = rescanStatus?.spf.record ?? spfRecord;

  // Classify selectors and group signed ones by provider
  const signedByProvider = new Map<string, { provider: EmailProvider; selectors: string[] }>();
  const unknown: typeof currentDkim.selectors = [];
  for (const sel of currentDkim.selectors) {
    const provider = matchDkimProvider(sel.name);
    if (provider) {
      const existing = signedByProvider.get(provider.name);
      const selectorPrefix = sel.name.replace(/\._domainkey.*$/, '');
      if (existing) existing.selectors.push(selectorPrefix);
      else signedByProvider.set(provider.name, { provider, selectors: [selectorPrefix] });
    } else {
      unknown.push(sel);
    }
  }
  const signedProviders = [...signedByProvider.values()];
  for (const sp of signedProviders) sp.selectors.sort();
  const unsigned = findUnsignedSpfProviders(currentDkim.selectors, currentSpf);
  const currentSev = dkimSeverity(currentDkim, dmarcPolicy, unsigned.length);

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

      {/* Signed senders — grouped by provider */}
      {signedProviders.length > 0 && (
        <>
          <p style={s.body}>
            {signedProviders.length} signed provider{signedProviders.length > 1 ? 's' : ''} detected:
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.5rem' }}>
            {signedProviders.map(({ provider, selectors }) => (
              <div key={provider.name} style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', padding: '0.5rem 0.75rem' }}>
                <strong style={{ fontSize: '0.85rem', color: '#15803d' }}>{provider.name}</strong>
                <code style={{ fontSize: '0.72rem', color: '#6b7280', fontFamily: 'monospace', marginLeft: '0.5rem' }}>
                  {selectors.join(', ')}
                </code>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Possibly unsigned — SPF providers with no matching DKIM */}
      {unsigned.length > 0 && (
        <>
          <p style={{ ...s.body, marginTop: signedProviders.length > 0 ? '0.75rem' : 0 }}>
            {unsigned.length} provider{unsigned.length > 1 ? 's' : ''} in your SPF record {unsigned.length > 1 ? 'appear' : 'appears'} to be missing DKIM:
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.5rem' }}>
            {unsigned.map(provider => (
              <div key={provider.include || provider.name} style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '6px', padding: '0.5rem 0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.25rem' }}>
                <strong style={{ fontSize: '0.85rem', color: '#92400e' }}>{provider.name}</strong>
                {provider.dkimGuideUrl && (
                  <a href={provider.dkimGuideUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.75rem', color: '#d97706' }}>
                    Set up DKIM →
                  </a>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Unknown selectors */}
      {unknown.length > 0 && (
        <>
          <p style={{ ...s.body, marginTop: (signedProviders.length > 0 || unsigned.length > 0) ? '0.75rem' : 0 }}>
            {unknown.length} unrecognised selector{unknown.length > 1 ? 's' : ''}:
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.5rem' }}>
            {unknown.map(sel => (
              <div key={sel.name} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '0.4rem 0.75rem' }}>
                <code style={{ fontSize: '0.78rem', color: '#6b7280', fontFamily: 'monospace' }}>{sel.name}</code>
                <span style={{ fontSize: '0.72rem', color: '#9ca3af', marginLeft: '0.5rem' }}>{sel.record.length > 60 ? sel.record.slice(0, 60) + '…' : sel.record}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* No DKIM at all */}
      {currentDkim.selectors.length === 0 && unsigned.length === 0 && (
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

      <StepNav onNext={onNext} onSkip={onSkip} showSkip={currentSev !== 'good'} />
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
  const [provisioningAuth, setProvisioningAuth] = useState(false);
  const [authProvisioned, setAuthProvisioned] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

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

      {/* Cross-domain DMARC report authorization record (RFC 7489 §7.1) */}
      {dmarc.auth_record && (
        <div style={{ marginTop: '1rem', padding: '0.75rem', background: (dmarc.auth_record.found || authProvisioned) ? '#e8f5e9' : '#fff3e0', borderRadius: '6px', border: `1px solid ${(dmarc.auth_record.found || authProvisioned) ? '#a5d6a7' : '#ffcc80'}` }}>
          <p style={{ ...s.label, marginBottom: '0.25rem' }}>Report authorization record</p>
          {(dmarc.auth_record.found || authProvisioned) ? (
            <p style={s.body}>
              <strong style={{ color: '#2e7d32' }}>Found.</strong>{' '}
              <code style={s.inline}>{dmarc.auth_record.record_name}</code> authorizes this domain to receive DMARC reports.
            </p>
          ) : (
            <div>
              <p style={s.body}>
                <strong style={{ color: '#e65100' }}>Missing.</strong>{' '}
                RFC 7489 requires a TXT record to authorize cross-domain report delivery.
                Without it, some providers may silently drop DMARC reports.
              </p>
              {dmarc.auth_record.record_name && (
                <div style={{ marginTop: '0.5rem' }}>
                  <p style={s.body}>Required record:</p>
                  <CodeBlock value={`${dmarc.auth_record.record_name}  TXT  "v=DMARC1;"`} onCopy={() => copy(`${dmarc.auth_record.record_name}  TXT  "v=DMARC1;"`)} copied={copied} />
                  {cf_available && dmarc.current_record && (
                    <button
                      onClick={async () => {
                        setProvisioningAuth(true);
                        setAuthError(null);
                        try {
                          await applyDmarc(status.domain_id, dmarc.current_record!);
                          setAuthProvisioned(true);
                        } catch (e: any) {
                          setAuthError(e.message ?? 'Failed to provision');
                        } finally {
                          setProvisioningAuth(false);
                        }
                      }}
                      disabled={provisioningAuth}
                      style={{ ...s.actionBtn, marginTop: '0.5rem', background: '#e65100', opacity: provisioningAuth ? 0.6 : 1 }}
                    >
                      {provisioningAuth ? 'Provisioning…' : 'Create via Cloudflare'}
                    </button>
                  )}
                  {authError && <p style={s.error}>{authError}</p>}
                </div>
              )}
            </div>
          )}
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

      {/* Null-sender protection */}
      <div style={{ marginBottom: '0.75rem' }}>
        <p style={s.label}>Subdomain protection</p>
        {current.null_sender_spf && current.null_sender_dmarc ? (
          <p style={s.body}>
            <code style={s.inline}>{current.reports_domain}</code> has null-sender SPF and DMARC records — it cannot be spoofed.
          </p>
        ) : (
          <>
            <p style={s.body}>
              Your reports subdomain <code style={s.inline}>{current.reports_domain ?? 'reports.yourdomain.com'}</code> lacks
              {!current.null_sender_spf && !current.null_sender_dmarc ? ' SPF and DMARC' : !current.null_sender_spf ? ' SPF' : ' DMARC'} records.
              Without these, anyone can send email pretending to be from this subdomain.
            </p>
            {current.mx_found && (
              <button
                onClick={setup}
                disabled={settingUp}
                style={{ ...s.actionBtn, background: '#d97706', opacity: settingUp ? 0.6 : 1, marginTop: '0.4rem' }}
              >
                {settingUp ? 'Setting up…' : 'Add null-sender protection'}
              </button>
            )}
            {setupError && <p style={s.error}>{setupError}</p>}
            {setupInfo && <p style={{ ...s.body, color: '#059669', fontSize: '0.9rem', marginTop: '0.5rem' }}>{setupInfo}</p>}
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
  // If domain already exists (domainIdProp set), clamp minimum to step 1 (SPF) — skip domain input
  const initialInternal = initialStep !== undefined ? initialStep - 1 : undefined;
  const clampedInitial = (initialInternal !== undefined && initialInternal < 1 && domainIdProp) ? 1 : initialInternal;
  const [step, setStepRaw] = useState(clampedInitial ?? 0);
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

        const [statusData, rawWizardData] = await Promise.all([
          getOnboardingStatus(id),
          getWizardState(id).catch(() => DEFAULT_WIZARD),
        ]);

        if (cancelled) return;
        setStatus(statusData);

        // Domain exists — ensure domain step is marked complete
        let wizardData = rawWizardData;
        if (wizardData.domain !== 'complete') {
          wizardData = { ...wizardData, domain: 'complete' };
          updateWizardState(id, { domain: 'complete' }).catch(() => {});
        }
        setWizardState(wizardData);

        // Jump to first incomplete step on resume (unless URL specified a step)
        // Skip step 0 (domain) — always start at SPF or later
        if (initialStep === undefined || (initialInternal !== undefined && initialInternal < 1)) {
          const firstIncomplete = STEP_KEYS.findIndex((k, i) => {
            if (i === 0) return false; // domain step handled above
            return wizardData[k] === 'not_started';
          });
          const target = firstIncomplete > 0 ? firstIncomplete : 1;
          setStepRaw(target);
          window.location.hash = `#/domains/${id}/setup/${target + 1}`;
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

        {step === 0 && needsDomain && <DomainStep onDomainSet={handleDomainSet} />}
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
