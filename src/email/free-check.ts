// Free email security check handler.
// Triggered when an email arrives at check-{token}@reports.inboxangel.io.
// The token ties the inbound email to a browser session for front-end polling.
// Parses auth headers, does live DNS lookup, replies with plain-English report, stores result in D1.

import { Env } from '../index';
import { extractAuthResults } from './parse-headers';
import { checkDomain } from './dns-check';
import { buildSummary, formatCheckReport } from './report-formatter';
import { insertCheckResult } from '../db/queries';

function extractDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : email.toLowerCase();
}

function buildMimeReply(from: string, to: string, subject: string, body: string): ReadableStream {
  const mimeContent = [
    'MIME-Version: 1.0',
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    body,
  ].join('\r\n');

  const bytes = new TextEncoder().encode(mimeContent);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function handleFreeCheck(
  message: ForwardableEmailMessage,
  env: Env,
  sessionToken: string,
): Promise<void> {
  const fromEmail = message.from;
  const domain = extractDomain(fromEmail);

  // 1. Parse Authentication-Results from inbound headers
  const auth = extractAuthResults(message.headers);

  // 2. Get DKIM selector (if present) for DNS lookup
  const dkimSelector = auth?.dkim?.selector ?? null;

  // 3. Live DNS lookup — SPF, DKIM (if selector known), DMARC
  const dns = await checkDomain(domain, dkimSelector);

  // 4. Build structured summary and format plain-English report
  const summary = buildSummary(domain, auth, dns);
  const reportText = formatCheckReport(fromEmail, summary, auth, dns);

  // 5. Send reply
  const replyFrom = `InboxAngel <${env.FROM_EMAIL}>`;
  const subject = `Email security check — ${domain}`;
  await message.reply(buildMimeReply(replyFrom, fromEmail, subject, reportText));

  // 6. Store result in D1 (best-effort — don't let DB failure break the email flow)
  try {
    await insertCheckResult(env.DB, {
      from_email: fromEmail,
      from_domain: domain,
      spf_result: (auth?.spf?.result ?? null) as any,
      spf_domain: auth?.spf?.domain ?? null,
      spf_record: dns.spf?.raw ?? null,
      dkim_result: (auth?.dkim?.result ?? null) as any,
      dkim_domain: auth?.dkim?.domain ?? null,
      dmarc_result: (auth?.dmarc?.result ?? null) as any,
      dmarc_policy: (dns.dmarc?.policy ?? null) as any,
      dmarc_record: dns.dmarc?.raw ?? null,
      overall_status: summary.status,
      report_sent: 1,
      session_token: sessionToken,
    });
  } catch (err) {
    console.error('free-check: D1 insert failed', err);
  }
}
