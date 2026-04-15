/**
 * Canonical date formatting for the dashboard.
 * All pages use these helpers — do not add inline date formatters elsewhere.
 */

/** Format a unix timestamp (seconds) or ISO date string as "Mar 18, 2026" */
export function formatDate(value: number | string): string {
  const d = typeof value === 'number'
    ? new Date(value * 1000)
    : (() => { const [y, m, day] = (value as string).split('-').map(Number); return new Date(y, m - 1, day); })();
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Format a unix timestamp or ISO date string as "Mar 18, 2026 · 2 days ago" */
export function formatDateWithRelative(value: number | string): string {
  return `${formatDate(value)} · ${relativeTime(value)}`;
}

/** Format a unix timestamp (seconds) as "Mar 18, 2026, 13:57" */
export function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** Return a relative time string, e.g. "2 days ago", "just now", "in 3 hours" */
export function relativeTime(value: number | string): string {
  const d = typeof value === 'number'
    ? new Date(value * 1000)
    : (() => { const [y, m, day] = (value as string).split('-').map(Number); return new Date(y, m - 1, day); })();
  const diffMs = Date.now() - d.getTime();
  const abs = Math.abs(diffMs);
  const suffix = diffMs >= 0 ? ' ago' : ' from now';

  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h${suffix}`;
  if (abs < 7 * 86_400_000) return `${Math.round(abs / 86_400_000)}d${suffix}`;
  if (abs < 30 * 86_400_000) return `${Math.round(abs / (7 * 86_400_000))}w${suffix}`;
  if (abs < 365 * 86_400_000) return `${Math.round(abs / (30 * 86_400_000))}mo${suffix}`;
  return `${Math.round(abs / (365 * 86_400_000))}y${suffix}`;
}
