import { describe, it, expect, vi } from 'vitest';
import { storeReport } from '../../src/dmarc/store-report';
import type { AggregateReport, ReportRecord } from '../../src/dmarc/types';

// ── Fixtures ──────────────────────────────────────────────────

function makeRecord(overrides: Partial<{
  ip: string;
  count: number;
  dkimResult: string;
  dkimDomain: string;
  spfResult: string;
  spfDomain: string;
  disposition: string;
  headerFrom: string;
}> = {}): ReportRecord {
  return {
    source: {
      ip: overrides.ip ?? '1.2.3.4',
      reverse_dns: null,
      base_domain: null,
      country_code: null,
      country_name: null,
      subdivision: null,
      city: null,
    },
    count: overrides.count ?? 1,
    alignment: { spf: true, dkim: true, dmarc: true },
    policy_evaluated: {
      disposition: (overrides.disposition ?? 'none') as any,
      dkim: (overrides.dkimResult ?? 'pass') as any,
      spf: (overrides.spfResult ?? 'pass') as any,
      policy_override_reasons: [],
    },
    identifiers: {
      header_from: overrides.headerFrom ?? 'example.com',
      envelope_from: null,
      envelope_to: null,
    },
    auth_results: {
      dkim: [{
        domain: overrides.dkimDomain ?? 'example.com',
        selector: 'sel',
        result: (overrides.dkimResult ?? 'pass') as any,
      }],
      spf: [{
        domain: overrides.spfDomain ?? 'example.com',
        scope: 'mfrom',
        result: (overrides.spfResult ?? 'pass') as any,
      }],
    },
  };
}

function makeReport(overrides: Partial<{
  orgName: string;
  reportId: string;
  beginDate: string;
  endDate: string;
  records: ReportRecord[];
}> = {}): AggregateReport {
  return {
    xml_schema: 'draft',
    report_metadata: {
      org_name: overrides.orgName ?? 'google.com',
      org_email: 'noreply@google.com',
      org_extra_contact_info: null,
      report_id: overrides.reportId ?? 'report-001',
      begin_date: overrides.beginDate ?? '2024-06-13T00:00:00Z',
      end_date: overrides.endDate ?? '2024-06-13T23:59:59Z',
      errors: [],
    },
    policy_published: {
      domain: 'example.com',
      adkim: 'r',
      aspf: 'r',
      p: 'reject',
      sp: 'reject',
      pct: 100,
      fo: '0',
    },
    records: overrides.records ?? [makeRecord()],
  };
}

// ── D1 mock builder ───────────────────────────────────────────
//
// Tracks: insertAggregateReport calls → lastRowId, insertReportRecords batch calls

interface MockDb {
  db: D1Database;
  aggregateInserts: any[][];   // args to each insertAggregateReport call
  recordBatches: any[][][];    // args per batch call (array of statement bind args)
  lastRowId: number;
}

function makeDb(lastRowId = 42): MockDb {
  const aggregateInserts: any[][] = [];
  const recordBatches: any[][][] = [];

  // The prepared statement: .bind(...) → .run() / .batch()
  const stmtFor = (sql: string) => ({
    bind: vi.fn((...args: any[]) => {
      if (sql.includes('aggregate_reports')) aggregateInserts.push(args);
      return {
        run: vi.fn().mockResolvedValue({ meta: { last_row_id: lastRowId } }),
      };
    }),
  });

  const db = {
    prepare: vi.fn((sql: string) => stmtFor(sql)),
    batch: vi.fn((stmts: any[]) => {
      // Capture bind args from each statement
      const batchArgs = stmts.map(s => s); // already bound
      recordBatches.push(batchArgs);
      return Promise.resolve(stmts.map(() => ({ success: true, meta: {} })));
    }),
  } as unknown as D1Database;

  return { db, aggregateInserts, recordBatches, lastRowId };
}

// ── Tests ─────────────────────────────────────────────────────

describe('storeReport', () => {
  it('returns stored=true and reportId on first insert', async () => {
    const { db } = makeDb(42);
    const result = await storeReport(db, 'org_abc', 1, makeReport());

    expect(result.stored).toBe(true);
    expect(result.reportId).toBe(42);
  });

  it('returns stored=false when INSERT OR IGNORE skips (last_row_id=0)', async () => {
    const { db } = makeDb(0); // 0 = ignored
    const result = await storeReport(db, 'org_abc', 1, makeReport());

    expect(result.stored).toBe(false);
    expect(result.reportId).toBeUndefined();
  });

  it('does not insert records when report was a duplicate', async () => {
    const { db, recordBatches } = makeDb(0);
    await storeReport(db, 'org_abc', 1, makeReport());

    expect(recordBatches).toHaveLength(0);
  });

  it('inserts records batch when report is new', async () => {
    const report = makeReport({
      records: [makeRecord({ ip: '10.0.0.1' }), makeRecord({ ip: '10.0.0.2' })],
    });
    const { db } = makeDb(7);
    const prepareMock = vi.fn((sql: string) => ({
      bind: vi.fn((...args: any[]) => ({
        run: vi.fn().mockResolvedValue({ meta: { last_row_id: 7 } }),
      })),
    }));
    const batchCalls: any[] = [];
    const mockDb = {
      prepare: prepareMock,
      batch: vi.fn((stmts) => {
        batchCalls.push(stmts);
        return Promise.resolve(stmts.map(() => ({ success: true, meta: {} })));
      }),
    } as unknown as D1Database;

    await storeReport(mockDb, 'org_abc', 1, report);
    // batch called once with 2 statements (one per record)
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(2);
  });

  it('skips batch insert entirely when report has no records', async () => {
    const batchCalls: any[] = [];
    const mockDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: vi.fn().mockResolvedValue({ meta: { last_row_id: 5 } }),
        })),
      })),
      batch: vi.fn((stmts) => { batchCalls.push(stmts); return Promise.resolve([]); }),
    } as unknown as D1Database;

    const report = makeReport({ records: [] });
    const result = await storeReport(mockDb, 'org_abc', 1, report);

    expect(result.stored).toBe(true);
    expect(batchCalls).toHaveLength(0);
  });

  // ── count arithmetic ─────────────────────────────────────────

  it('computes total_count as sum of all record.count values', async () => {
    const captured: any[] = [];
    const mockDb = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...args: any[]) => {
          if (sql.includes('aggregate_reports')) captured.push(args);
          return { run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1 } }) };
        }),
      })),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database;

    const report = makeReport({
      records: [
        makeRecord({ count: 10 }),
        makeRecord({ count: 5 }),
        makeRecord({ count: 3 }),
      ],
    });
    await storeReport(mockDb, 'org_abc', 1, report);

    // total_count is the 7th bind arg: (customer_id, domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, raw_xml)
    const args = captured[0];
    const totalCount = args[6];
    expect(totalCount).toBe(18); // 10+5+3
  });

  it('counts pass_count weighted by message count (dkim pass)', async () => {
    const captured: any[] = [];
    const mockDb = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...args: any[]) => {
          if (sql.includes('aggregate_reports')) captured.push(args);
          return { run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1 } }) };
        }),
      })),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database;

    const report = makeReport({
      records: [
        makeRecord({ count: 10, dkimResult: 'pass', spfResult: 'fail' }), // passes
        makeRecord({ count: 5,  dkimResult: 'fail', spfResult: 'fail' }), // fails
        makeRecord({ count: 3,  dkimResult: 'fail', spfResult: 'pass' }), // passes (via SPF)
      ],
    });
    await storeReport(mockDb, 'org_abc', 1, report);

    const args = captured[0];
    // (customer_id[0], domain_id[1], org_name[2], report_id[3], date_begin[4], date_end[5], total_count[6], pass_count[7], fail_count[8], raw_xml[9])
    expect(args[6]).toBe(18);  // total
    expect(args[7]).toBe(13);  // pass: 10+3
    expect(args[8]).toBe(5);   // fail: 5
  });

  it('converts ISO date strings to unix timestamps', async () => {
    const captured: any[] = [];
    const mockDb = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...args: any[]) => {
          if (sql.includes('aggregate_reports')) captured.push(args);
          return { run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1 } }) };
        }),
      })),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database;

    const report = makeReport({
      beginDate: '2024-06-13T00:00:00Z',
      endDate:   '2024-06-13T23:59:59Z',
    });
    await storeReport(mockDb, 'org_abc', 1, report);

    const args = captured[0];
    expect(args[4]).toBe(1718236800); // 2024-06-13 00:00:00 UTC
    expect(args[5]).toBe(1718323199); // 2024-06-13 23:59:59 UTC
  });

  it('passes rawXml to the insert', async () => {
    const captured: any[] = [];
    const mockDb = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...args: any[]) => {
          if (sql.includes('aggregate_reports')) captured.push(args);
          return { run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1 } }) };
        }),
      })),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database;

    await storeReport(mockDb, 'org_abc', 1, makeReport(), '<xml>raw</xml>');
    expect(captured[0][9]).toBe('<xml>raw</xml>');
  });

  it('passes null rawXml when not provided', async () => {
    const captured: any[] = [];
    const mockDb = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...args: any[]) => {
          if (sql.includes('aggregate_reports')) captured.push(args);
          return { run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1 } }) };
        }),
      })),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database;

    await storeReport(mockDb, 'org_abc', 1, makeReport());
    expect(captured[0][9]).toBeNull();
  });

  it('maps record source_ip from source.ip', async () => {
    const batchArgs: any[] = [];
    const mockDb = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...args: any[]) => {
          if (sql.includes('report_records')) batchArgs.push(args);
          return { run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1 } }) };
        }),
      })),
      batch: vi.fn((stmts) => Promise.resolve(stmts.map(() => ({ success: true })))),
    } as unknown as D1Database;

    const report = makeReport({ records: [makeRecord({ ip: '192.168.1.100' })] });
    await storeReport(mockDb, 'org_abc', 1, report);

    // source_ip is the 3rd bind arg (report_id, customer_id, source_ip, ...)
    expect(batchArgs[0][2]).toBe('192.168.1.100');
  });

  it('handles record with no DKIM auth result gracefully (null fields)', async () => {
    const batchArgs: any[] = [];
    const mockDb = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...args: any[]) => {
          if (sql.includes('report_records')) batchArgs.push(args);
          return { run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1 } }) };
        }),
      })),
      batch: vi.fn((stmts) => Promise.resolve(stmts.map(() => ({ success: true })))),
    } as unknown as D1Database;

    const rec: ReportRecord = {
      ...makeRecord(),
      auth_results: { dkim: [], spf: [] }, // empty auth results
    };
    const report = makeReport({ records: [rec] });
    await storeReport(mockDb, 'org_abc', 1, report);

    // dkim_result and spf_result should be null (not crash)
    expect(batchArgs[0][6]).toBeNull(); // dkim_result
    expect(batchArgs[0][8]).toBeNull(); // spf_result
  });
});
