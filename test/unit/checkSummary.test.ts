import { describe, it, expect, vi } from 'vitest';
import { getCheckSummary } from '../../src/db/queries';

function makeDb(firstResult: unknown = null) {
  const firstFn = vi.fn().mockResolvedValue(firstResult);
  const bindFn = vi.fn().mockReturnValue({ first: firstFn });
  const prepareFn = vi.fn().mockReturnValue({ bind: bindFn });
  return { prepare: prepareFn, _first: firstFn, _bind: bindFn };
}

describe('getCheckSummary', () => {
  it('calls db.prepare with a SELECT query', () => {
    const db = makeDb();
    getCheckSummary(db as unknown as D1Database, 1, 0);
    expect(db.prepare).toHaveBeenCalledOnce();
    const sql: string = db.prepare.mock.calls[0][0];
    expect(sql).toMatch(/SELECT/i);
    expect(sql).toContain('domain_id');
    expect(sql).toContain('dmarc_policy');
  });

  it('binds since and domainId parameters in the right order', () => {
    const db = makeDb();
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    getCheckSummary(db as unknown as D1Database, 42, since);
    expect(db._bind).toHaveBeenCalledWith(since, 42);
  });

  it('returns the value from .first()', async () => {
    const mockSummary = {
      domain_id: 1, domain: 'example.com', dmarc_policy: 'reject',
      spf_record: 'v=spf1 ~all', total_messages: 1000, pass_messages: 980,
      fail_messages: 20, dkim_total: 1000, dkim_pass: 950,
      spf_total: 1000, spf_pass: 960, mta_sts_enabled: 1, mta_sts_mode: 'enforce',
    };
    const db = makeDb(mockSummary);
    const result = await getCheckSummary(db as unknown as D1Database, 1, 0);
    expect(result).toEqual(mockSummary);
  });

  it('returns null when domain does not exist', async () => {
    const db = makeDb(null);
    const result = await getCheckSummary(db as unknown as D1Database, 999, 0);
    expect(result).toBeNull();
  });

  it('query includes mta_sts_config join', () => {
    const db = makeDb();
    getCheckSummary(db as unknown as D1Database, 1, 0);
    const sql: string = db.prepare.mock.calls[0][0];
    expect(sql).toContain('mta_sts_config');
  });

  it('query includes report_records join for DKIM/SPF stats', () => {
    const db = makeDb();
    getCheckSummary(db as unknown as D1Database, 1, 0);
    const sql: string = db.prepare.mock.calls[0][0];
    expect(sql).toContain('report_records');
    expect(sql).toContain('dkim_result');
    expect(sql).toContain('spf_result');
  });
});
