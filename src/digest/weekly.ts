// Weekly DMARC digest emails.
// Runs every Monday (cron "0 9 * * 1") and sends a per-customer summary of
// the past 7 days of DMARC aggregate reports.
//
// Delivery: Resend API if RESEND_API_KEY is set, console.log otherwise.

import { getAllCustomers, getWeeklyDomainStats, getTopFailingSources, DomainWeeklyStat, FailingSource } from '../db/queries';

export interface DigestEnv {
  DB: D1Database;
  RESEND_API_KEY?: string;
  FROM_EMAIL: string;
  REPORTS_DOMAIN: string;
}

// ── Formatting ────────────────────────────────────────────────

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

function policyBadge(policy: string | null): string {
  if (policy === 'reject')     return 'reject ✅';
  if (policy === 'quarantine') return 'quarantine ⚠️';
  if (policy === 'none')       return 'none ❌';
  return '(not set) ❌';
}

function formatDomainSection(
  stat: DomainWeeklyStat,
  sources: FailingSource[],
  ruaAddress: string,
): string {
  const lines: string[] = [`Domain: ${stat.domain}`];
  lines.push(`DMARC policy: ${policyBadge(stat.dmarc_policy)}`);

  if (stat.total_messages === 0) {
    lines.push('No reports received this week.');
    lines.push(`Check that rua=mailto:${ruaAddress} is in your DMARC record.`);
    return lines.join('\n');
  }

  lines.push(`Messages this week: ${stat.total_messages.toLocaleString()}`);
  lines.push(`  ✅ Passed: ${stat.pass_messages.toLocaleString()} (${pct(stat.pass_messages, stat.total_messages)})`);
  lines.push(`  ❌ Failed: ${stat.fail_messages.toLocaleString()} (${pct(stat.fail_messages, stat.total_messages)})`);

  if (sources.length > 0) {
    lines.push('');
    lines.push('Top failing sources:');
    for (const s of sources) {
      const from = s.header_from ? ` (${s.header_from})` : '';
      lines.push(`  ${s.source_ip}${from} — ${s.total.toLocaleString()} failures`);
    }
  }

  return lines.join('\n');
}

export function buildDigestBody(
  customerName: string,
  stats: DomainWeeklyStat[],
  sourcesByDomain: Map<number, FailingSource[]>,
  weekLabel: string,
  ruaAddress: string,
  reportsDomain: string,
): string {
  const lines: string[] = [
    `Hi ${customerName},`,
    '',
    `Here's your DMARC summary for the week of ${weekLabel}.`,
    '',
  ];

  for (const stat of stats) {
    lines.push(formatDomainSection(stat, sourcesByDomain.get(stat.domain_id) ?? [], ruaAddress));
    lines.push('');
  }

  // CTA for degraded domains (policy = none or missing)
  const weak = stats.filter(s => s.dmarc_policy === 'none' || !s.dmarc_policy);
  if (weak.length > 0) {
    lines.push(`${weak.map(s => s.domain).join(', ')} ${weak.length === 1 ? 'is' : 'are'} not enforcing DMARC.`);
    lines.push(`Want us to fix it for you? Visit https://${reportsDomain.replace(/^reports\./, '')}`);
    lines.push('');
  }

  lines.push('—');
  lines.push('InboxAngel weekly digest');

  return lines.join('\n');
}

// ── Delivery ──────────────────────────────────────────────────

async function sendDigest(
  email: string,
  subject: string,
  body: string,
  env: DigestEnv,
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[digest] would send to ${email}: ${subject}\n${body}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `InboxAngel <${env.FROM_EMAIL}>`,
      to: [email],
      subject,
      text: body,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[digest] Resend error ${res.status} for ${email}: ${text}`);
  }
}

// ── Main ──────────────────────────────────────────────────────

export async function sendWeeklyDigests(env: DigestEnv, now = Date.now()): Promise<void> {
  const since = Math.floor(now / 1000) - 7 * 24 * 60 * 60; // 7 days ago in Unix seconds
  const weekLabel = new Date(since * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
  const ruaAddress = `rua@${env.REPORTS_DOMAIN}`;

  const { results: customers } = await getAllCustomers(env.DB);
  console.log(`[digest] sending weekly digest to ${customers.length} customer(s)`);

  for (const customer of customers) {
    try {
      const { results: stats } = await getWeeklyDomainStats(env.DB, customer.id, since);
      if (stats.length === 0) continue; // no domains — nothing to send

      // Fetch top failing sources for domains that had failures
      const sourcesByDomain = new Map<number, FailingSource[]>();
      for (const stat of stats) {
        if (stat.fail_messages > 0) {
          const { results: sources } = await getTopFailingSources(env.DB, stat.domain_id, since);
          sourcesByDomain.set(stat.domain_id, sources);
        }
      }

      const body = buildDigestBody(customer.name, stats, sourcesByDomain, weekLabel, ruaAddress, env.REPORTS_DOMAIN);
      const hasIssues = stats.some(s => s.fail_messages > 0 || !s.dmarc_policy || s.dmarc_policy === 'none');
      const subject = hasIssues
        ? `⚠️ DMARC Weekly Digest — action needed`
        : `✅ DMARC Weekly Digest — all clear`;

      await sendDigest(customer.email, subject, body, env);
      console.log(`[digest] sent to ${customer.email} (${stats.length} domain(s))`);
    } catch (e) {
      console.error(`[digest] error for customer ${customer.id}:`, e);
    }
  }
}
