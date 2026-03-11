// "First report received" notification — fires once per domain when
// the very first DMARC aggregate report is successfully stored.
// Delivery: Cloudflare Email Workers (SEND_EMAIL binding).
// Falls back to console.log if binding is absent.

import { fromEmail, getAccountId } from '../env-utils';
import { getSetting, setSetting } from '../db/queries';

export interface FirstReportEnv {
  DB: D1Database;
  SEND_EMAIL?: SendEmail;
  WORKER_NAME?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

export interface ReportStats {
  totalMessages: number;
  passMessages: number;
  failMessages: number;
  sourceCount: number;
}

// ── Formatting ────────────────────────────────────────────────

export function buildFirstReportBody(
  recipientName: string,
  domain: string,
  stats: ReportStats,
  dashboardUrl: string,
): string {
  const passRate = stats.totalMessages > 0
    ? Math.round((stats.passMessages / stats.totalMessages) * 100)
    : 0;

  const lines: string[] = [
    `Hi ${recipientName},`,
    '',
    `Great news! We just received the first DMARC aggregate report for ${domain}.`,
    '',
    'Here are the highlights:',
    `  - ${stats.totalMessages.toLocaleString()} email(s) analyzed`,
    `  - ${stats.sourceCount.toLocaleString()} sending source(s) detected`,
    `  - ${passRate}% pass rate (${stats.passMessages.toLocaleString()} passed, ${stats.failMessages.toLocaleString()} failed)`,
    '',
    `View the full report on your dashboard: ${dashboardUrl}`,
    '',
    'It can take 24-48 hours after publishing your DMARC record for reports to start arriving.',
    'Now that the first one is in, you can expect daily reports from major mailbox providers.',
    '',
    '—',
    'InboxAngel notifications',
  ];

  return lines.join('\n');
}

// ── Workers subdomain resolution ─────────────────────────────

async function resolveWorkersSubdomain(env: FirstReportEnv): Promise<string | null> {
  // 1. Check D1 cache
  const cached = await getSetting(env.DB, 'workers_subdomain');
  if (cached?.value) return cached.value;

  // 2. Query CF API: GET /accounts/{account_id}/workers/subdomain
  const accountId = getAccountId();
  if (!accountId || !env.CLOUDFLARE_API_TOKEN) return null;

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } },
    );
    if (!res.ok) return null;
    const data = await res.json() as { result?: { subdomain: string } };
    const subdomain = data.result?.subdomain ?? null;
    if (subdomain) {
      // Cache in D1 for future cold starts
      await setSetting(env.DB, 'workers_subdomain', subdomain).catch(() => {});
    }
    return subdomain;
  } catch {
    return null;
  }
}

// ── Delivery ──────────────────────────────────────────────────

export async function sendFirstReportNotification(
  env: FirstReportEnv,
  domain: string,
  reportStats: ReportStats,
): Promise<void> {
  // Resolve dashboard URL: custom domain > {worker}.{subdomain}.workers.dev
  const customDomain = await getSetting(env.DB, 'custom_domain');
  let dashboardUrl: string;
  if (customDomain?.value) {
    dashboardUrl = `https://${customDomain.value}`;
  } else {
    const workerName = env.WORKER_NAME ?? 'inbox-angel-worker';
    const subdomain = await resolveWorkersSubdomain(env);
    dashboardUrl = subdomain
      ? `https://${workerName}.${subdomain}.workers.dev`
      : `https://${workerName}.workers.dev`;
  }

  // Get admin user email
  const admin = await env.DB.prepare(`SELECT email, name FROM users WHERE role = 'admin' LIMIT 1`)
    .first<{ email: string; name: string }>();
  if (!admin) {
    console.log('[first-report] no admin user found — skipping notification');
    return;
  }

  const subject = `\u{1F389} First DMARC report received for ${domain}`;
  const body = buildFirstReportBody(admin.name ?? 'there', domain, reportStats, dashboardUrl);

  if (!env.SEND_EMAIL) {
    console.log(`[first-report] SEND_EMAIL binding not configured — would send to ${admin.email}: ${subject}\n${body}`);
    return;
  }

  try {
    await env.SEND_EMAIL.send({
      from: { name: 'InboxAngel', email: fromEmail()! },
      to: [admin.email],
      subject,
      text: body,
    });
    console.log(`[first-report] sent notification to ${admin.email} for ${domain}`);
  } catch (e) {
    console.error(`[first-report] send failed for ${admin.email}:`, e);
  }
}
