/**
 * Shared wizard primitives — extracted from Onboarding.tsx.
 * Used by Onboarding, SpfFlattenWizard, and MtaStsWizard.
 */
import { useState } from 'preact/hooks';

// ── Severity system ──────────────────────────────────────────────

export type Severity = 'good' | 'info' | 'warning' | 'error';

export const SEV_COLOR: Record<Severity, string> = {
  good: '#16a34a', info: '#2563eb', warning: '#d97706', error: '#dc2626',
};
export const SEV_BG: Record<Severity, string> = {
  good: '#f0fdf4', info: '#eff6ff', warning: '#fffbeb', error: '#fef2f2',
};
export const SEV_LABEL: Record<Severity, string> = {
  good: '✓ All good', info: 'ℹ Info', warning: '⚠ Needs attention', error: '✕ Action required',
};

// ── Badge ────────────────────────────────────────────────────────

export function Badge({ sev }: { sev: Severity }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '9999px',
      fontSize: '0.72rem',
      fontWeight: 700,
      color: SEV_COLOR[sev],
      background: SEV_BG[sev],
    }}>
      {SEV_LABEL[sev]}
    </span>
  );
}

// ── CodeBlock ────────────────────────────────────────────────────

export function CodeBlock({ value, onCopy, copied }: { value: string; onCopy: () => void; copied: boolean }) {
  return (
    <div style={{ position: 'relative' as const }}>
      <pre style={{
        background: '#f9fafb',
        border: '1px solid #e5e7eb',
        borderRadius: '6px',
        padding: '0.75rem 3rem 0.75rem 0.75rem',
        fontSize: '0.78rem',
        fontFamily: 'monospace',
        whiteSpace: 'pre-wrap' as const,
        wordBreak: 'break-all' as const,
        margin: 0,
        color: '#374151',
        overflowX: 'auto' as const,
      }}>
        {value}
      </pre>
      <button
        onClick={onCopy}
        style={{
          position: 'absolute' as const,
          top: '0.5rem',
          right: '0.5rem',
          padding: '0.2rem 0.5rem',
          fontSize: '0.72rem',
          background: '#fff',
          border: '1px solid #d1d5db',
          borderRadius: '4px',
          cursor: 'pointer',
          color: '#374151',
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

// ── StepProgress ─────────────────────────────────────────────────

export function StepProgress({
  current,
  total,
  labels,
  completedSteps,
  skippedSteps,
}: {
  current: number;
  total: number;
  labels?: string[];
  completedSteps?: Set<number>;
  skippedSteps?: Set<number>;
}) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', justifyContent: 'center', marginBottom: '1.5rem' }}>
      {Array.from({ length: total }, (_, i) => {
        const isComplete = completedSteps?.has(i);
        const isSkipped = skippedSteps?.has(i);
        const isCurrent = i === current;
        const bg = isComplete ? '#16a34a' : isSkipped ? '#d97706' : isCurrent ? '#111827' : '#d1d5db';
        return (
          <div key={i} style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: '0.25rem' }}>
            <div style={{
              width: '10px', height: '10px', borderRadius: '50%', background: bg, transition: 'background 0.2s',
            }} />
            {labels && labels[i] && (
              <span style={{ fontSize: '0.6rem', color: isCurrent ? '#111827' : '#9ca3af', whiteSpace: 'nowrap' as const }}>
                {labels[i]}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── StepNav ──────────────────────────────────────────────────────

export function StepNav({
  onNext,
  onSkip,
  onBack,
  nextLabel = 'Continue →',
  backLabel = '← Back',
  showSkip = true,
  showBack = false,
}: {
  onNext: () => void;
  onSkip?: () => void;
  onBack?: () => void;
  nextLabel?: string;
  backLabel?: string;
  showSkip?: boolean;
  showBack?: boolean;
}) {
  return (
    <div style={wizardStyles.nav}>
      {showBack && onBack ? (
        <button onClick={onBack} style={wizardStyles.skipLink}>{backLabel}</button>
      ) : showSkip && onSkip ? (
        <button onClick={onSkip} style={wizardStyles.skipLink}>Skip</button>
      ) : (
        <span />
      )}
      <button onClick={onNext} style={wizardStyles.nextBtn}>{nextLabel}</button>
    </div>
  );
}

// ── useCopyClipboard hook ────────────────────────────────────────

export function useCopyClipboard(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return [copied, copy];
}

// ── Shared wizard styles ─────────────────────────────────────────

export const wizardStyles = {
  wrap: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    maxWidth: '620px',
    margin: '0 auto',
    padding: '2rem 1.5rem 3rem',
    color: '#111827',
  } as const,
  card: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: '12px',
    padding: '2rem',
    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  } as const,
  stepTitle: {
    fontSize: '1.15rem',
    fontWeight: 700,
    marginBottom: '1rem',
    marginTop: 0,
  } as const,
  label: {
    display: 'block' as const,
    fontSize: '0.78rem',
    fontWeight: 600,
    color: '#6b7280',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    marginBottom: '0.35rem',
  } as const,
  body: {
    fontSize: '0.88rem',
    color: '#374151',
    lineHeight: 1.6,
    margin: '0 0 1rem',
  } as const,
  inline: {
    fontFamily: 'monospace',
    fontSize: '0.82rem',
    color: '#374151',
  } as const,
  nav: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: '1.5rem',
  } as const,
  nextBtn: {
    padding: '0.5rem 1.25rem',
    background: '#111827',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.875rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
  } as const,
  actionBtn: {
    padding: '0.5rem 1.25rem',
    background: '#111827',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.875rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
  } as const,
  secondaryBtn: {
    padding: '0.5rem 1.25rem',
    background: '#fff',
    color: '#374151',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '0.875rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
  } as const,
  skipLink: {
    background: 'none',
    border: 'none',
    padding: 0,
    fontSize: '0.8rem',
    color: '#9ca3af',
    cursor: 'pointer',
    fontFamily: 'inherit',
  } as const,
  error: {
    color: '#dc2626',
    fontSize: '0.8rem',
    marginTop: '0.5rem',
  } as const,
};
