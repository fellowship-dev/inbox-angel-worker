// Stores a parsed DMARC aggregate report into D1.
// Handles deduplication via INSERT OR IGNORE — re-deliveries of the same
// report_id are silently skipped (returns { stored: false }).

import { AggregateReport, ReportRecord as ParserRecord } from './types';
import { insertAggregateReport, insertReportRecords } from '../db/queries';
import { ReportRecord as DbRecord } from '../db/types';

export interface StoreReportResult {
  stored: boolean;       // false = duplicate, records not re-inserted
  reportId?: number;     // D1 auto-increment id of the aggregate_reports row
}

// ── Helpers ───────────────────────────────────────────────────

function isoToUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

// A record "passes" DMARC if at least one of dkim or spf aligned.
// Weighted by message count (each record represents N messages from the same IP).
function computeCounts(records: ParserRecord[]): {
  total: number;
  pass: number;
  fail: number;
} {
  let total = 0;
  let pass = 0;

  for (const rec of records) {
    const count = rec.count;
    total += count;
    const dkimPass = rec.policy_evaluated.dkim === 'pass';
    const spfPass  = rec.policy_evaluated.spf  === 'pass';
    if (dkimPass || spfPass) pass += count;
  }

  return { total, pass, fail: total - pass };
}

// Maps a parser ReportRecord to a D1 report_records row.
// Takes the D1 aggregate_reports.id (reportId) and customer_id for denormalization.
function mapRecord(
  rec: ParserRecord,
  reportId: number,
  customerId: string,
): Omit<DbRecord, 'id' | 'created_at'> {
  return {
    report_id: reportId,
    customer_id: customerId,
    source_ip: rec.source.ip,
    count: rec.count,
    disposition: rec.policy_evaluated.disposition,
    dkim_result: (rec.auth_results.dkim[0]?.result ?? null) as DbRecord['dkim_result'],
    dkim_domain: rec.auth_results.dkim[0]?.domain ?? null,
    spf_result:  (rec.auth_results.spf[0]?.result  ?? null) as DbRecord['spf_result'],
    spf_domain:  rec.auth_results.spf[0]?.domain  ?? null,
    header_from: rec.identifiers.header_from,
  };
}

// ── Main export ───────────────────────────────────────────────

/**
 * Inserts an aggregate report + its records into D1.
 *
 * @param db          D1Database binding
 * @param customerId  Auth0 org_id of the receiving customer
 * @param domainId    D1 domains.id for the monitored domain
 * @param report      Parsed AggregateReport from parseDmarcEmail()
 * @param rawXml      Original XML string to store for reprocessing (nullable)
 */
export async function storeReport(
  db: D1Database,
  customerId: string,
  domainId: number,
  report: AggregateReport,
  rawXml: string | null = null,
): Promise<StoreReportResult> {
  const { total, pass, fail } = computeCounts(report.records);
  const meta = report.report_metadata;

  const insertResult = await insertAggregateReport(db, {
    customer_id: customerId,
    domain_id:   domainId,
    org_name:    meta.org_name,
    report_id:   meta.report_id,
    date_begin:  isoToUnix(meta.begin_date),
    date_end:    isoToUnix(meta.end_date),
    total_count: total,
    pass_count:  pass,
    fail_count:  fail,
    raw_xml:     rawXml,
  });

  // INSERT OR IGNORE — if last_row_id is falsy the row was a duplicate
  const reportId = insertResult.meta?.last_row_id;
  if (!reportId) return { stored: false };

  // Batch-insert all per-IP records
  if (report.records.length > 0) {
    await insertReportRecords(
      db,
      report.records.map(r => mapRecord(r, reportId, customerId)),
    );
  }

  return { stored: true, reportId };
}
