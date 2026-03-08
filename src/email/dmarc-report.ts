// Handles inbound DMARC aggregate report emails.
// Triggered for any address other than check@reports.inboxangel.com.
// Flow: extract bytes → resolve customer → parse XML → store in D1.

import { Env } from '../index';
import { extractAttachmentBytes, MimeExtractError } from './mime-extract';
import { resolveCustomer } from './resolve-customer';
import { parseDmarcEmail, ParseEmailError } from '../dmarc/parse-email';
import { storeReport } from '../dmarc/store-report';

export async function handleDmarcReport(
  message: ForwardableEmailMessage,
  env: Env,
  _localPart: string,
): Promise<void> {
  // 1. Extract attachment bytes from raw MIME stream
  let bytes: Uint8Array;
  try {
    bytes = await extractAttachmentBytes(message.raw);
  } catch (err) {
    const reason = err instanceof MimeExtractError
      ? `Could not extract attachment: ${err.message}`
      : 'Unexpected error reading email';
    console.error('dmarc-report: mime extraction failed', err);
    message.setReject(reason);
    return;
  }

  // 2. Resolve customer + domain from the recipient address
  const resolved = await resolveCustomer(env.DB, message.to);
  if (!resolved) {
    console.warn('dmarc-report: unknown recipient address', message.to);
    message.setReject('Unknown recipient address — not a registered InboxAngel inbox');
    return;
  }
  const { customer, domain } = resolved;

  // 3. Parse the DMARC XML
  let report;
  let rawXml: string | null = null;
  try {
    report = await parseDmarcEmail(bytes);

    // Best-effort: store raw XML for plain XML attachments (gz/zip → null)
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (decoded.trimStart().startsWith('<?xml') || decoded.trimStart().startsWith('<feed')) {
        rawXml = decoded;
      }
    } catch {
      // Binary attachment — rawXml stays null
    }
  } catch (err) {
    const reason = err instanceof ParseEmailError
      ? `Invalid DMARC report: ${err.message}`
      : 'Unexpected error parsing DMARC report';
    console.error('dmarc-report: parse failed for', domain.domain, err);
    message.setReject(reason);
    return;
  }

  // 4. Store in D1 (dedup handled by INSERT OR IGNORE inside storeReport)
  try {
    const result = await storeReport(env.DB, customer.id, domain.id, report, rawXml);
    if (result.stored) {
      console.log(
        `dmarc-report: stored report ${report.report_metadata.report_id} ` +
        `for ${domain.domain} (id=${result.reportId}, records=${report.records.length})`
      );
    } else {
      console.log(
        `dmarc-report: duplicate report ${report.report_metadata.report_id} ` +
        `for ${domain.domain} — skipped`
      );
    }
  } catch (err) {
    // Log but don't reject — email was valid, just a storage failure
    console.error('dmarc-report: D1 storage failed for', domain.domain, err);
  }
}
