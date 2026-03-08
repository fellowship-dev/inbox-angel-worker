// Change notification emails for domain monitoring.
// Uses Resend API when RESEND_API_KEY is set; logs to console otherwise (dev/self-host).

import { DomainChange } from './check';

export interface NotifyEnv {
  RESEND_API_KEY?: string;
  FROM_EMAIL: string;
  REPORTS_DOMAIN: string;
}

const SEVERITY_EMOJI: Record<DomainChange['severity'], string> = {
  improved: '✅',
  degraded: '🚨',
  changed: '⚠️',
};

function buildEmailBody(domain: string, changes: DomainChange[], reportsDomain: string): string {
  const lines: string[] = [
    `We detected changes to the email security configuration of ${domain}.`,
    '',
    ...changes.map(c =>
      `${SEVERITY_EMOJI[c.severity]} ${c.field}\n   Was: ${c.was || '(not set)'}\n   Now: ${c.now || '(removed)'}`
    ),
    '',
  ];

  const hasDegraded = changes.some(c => c.severity === 'degraded');
  if (hasDegraded) {
    lines.push(
      'Some of these changes may leave your domain exposed to spoofing.',
      'Want us to fix it for you? Reply to this email or sign up at https://' + reportsDomain.replace(/^reports\./, ''),
      '',
    );
  } else {
    lines.push('No action required — these look like improvements or routine updates.');
    lines.push('');
  }

  lines.push('—');
  lines.push('InboxAngel domain monitoring');
  lines.push(`To stop alerts for ${domain}, reply with "unsubscribe".`);

  return lines.join('\n');
}

export async function sendChangeNotification(
  email: string,
  domain: string,
  changes: DomainChange[],
  env: NotifyEnv,
): Promise<void> {
  const hasDegraded = changes.some(c => c.severity === 'degraded');
  const subject = hasDegraded
    ? `⚠️ ${domain} email security degraded`
    : `${domain} email security updated`;

  const body = buildEmailBody(domain, changes, env.REPORTS_DOMAIN);

  if (!env.RESEND_API_KEY) {
    console.log(`[notify] would send to ${email}: ${subject}\n${body}`);
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
    console.error(`[notify] Resend API error ${res.status}: ${text}`);
  }
}
