import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/index';

// Mock auth so all requests pass with userId = 'org_test'
vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test' }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

// Mock DNS provisioning so tests don't hit Cloudflare
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'cf-rec-1', recordName: 'test._report._dmarc.reports.inboxangel.io', manual: false }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {
    constructor(msg: string) { super(msg); this.name = 'DnsProvisionError'; }
  },
}));

import { logAudit, AuditEntry } from '../../src/audit/log';
import { handleApi } from '../../src/api/router';
import * as authMod from '../../src/api/auth';

// ── Helpers ───────────────────────────────────────────────────

const BASE = 'https://api.inboxangel.com';

/** Build a mock D1Database that records all prepared SQL + bound params. */
function makeMockDb() {
  const calls: { sql: string; params: unknown[] }[] = [];
  let runResult: unknown = { success: true, meta: { last_row_id: 1 } };
  let firstResult: unknown = null;
  let allResult: unknown = { results: [] };
  let shouldReject = false;

  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      const call = { sql, params: [] as unknown[] };
      calls.push(call);
      return {
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          call.params = args;
          return {
            run: shouldReject
              ? vi.fn().mockRejectedValue(new Error('DB write failed'))
              : vi.fn().mockResolvedValue(runResult),
            first: vi.fn().mockResolvedValue(firstResult),
            all: vi.fn().mockResolvedValue(allResult),
          };
        }),
        run: shouldReject
          ? vi.fn().mockRejectedValue(new Error('DB write failed'))
          : vi.fn().mockResolvedValue(runResult),
        first: vi.fn().mockResolvedValue(firstResult),
        all: vi.fn().mockResolvedValue(allResult),
      };
    }),
    batch: vi.fn().mockResolvedValue([]),
    _calls: calls,
    _setRunResult: (v: unknown) => { runResult = v; },
    _setFirstResult: (v: unknown) => { firstResult = v; },
    _setAllResult: (v: unknown) => { allResult = v; },
    _setShouldReject: (v: boolean) => { shouldReject = v; },
  };
  return db;
}

function makeEnv(dbOverride?: unknown): Env {
  return {
    DB: (dbOverride ?? makeMockDb()) as unknown as D1Database,
    ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
    API_KEY: 'test-key',
    REPORTS_DOMAIN: 'reports.inboxangel.io',
    FROM_EMAIL: 'check@reports.inboxangel.io',
  };
}

function req(method: string, path: string, body?: unknown, headers?: Record<string, string>): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

// ── logAudit() unit tests ────────────────────────────────────

describe('logAudit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes an entry to the DB with correct fields', async () => {
    const db = makeMockDb();
    const entry: AuditEntry = {
      actor_id: 'user-1',
      actor_email: 'user@test.com',
      actor_type: 'user',
      action: 'domain.add',
      resource_type: 'domain',
      resource_id: '42',
      resource_name: 'example.com',
      after_value: { domain: 'example.com' },
    };

    logAudit(db as unknown as D1Database, entry);

    // Wait for the async run to complete
    await new Promise(r => setTimeout(r, 10));

    expect(db.prepare).toHaveBeenCalledTimes(1);
    const sql = db._calls[0].sql;
    expect(sql).toContain('INSERT INTO audit_log');
    const params = db._calls[0].params;
    expect(params[0]).toBe('user-1');        // actor_id
    expect(params[1]).toBe('user@test.com'); // actor_email
    expect(params[2]).toBe('user');          // actor_type
    expect(params[3]).toBe('domain.add');    // action
    expect(params[4]).toBe('domain');        // resource_type
    expect(params[5]).toBe('42');            // resource_id
    expect(params[6]).toBe('example.com');   // resource_name
  });

  it('serializes before_value/after_value as JSON strings', async () => {
    const db = makeMockDb();
    const entry: AuditEntry = {
      action: 'test.action',
      before_value: { old: true },
      after_value: { new: true, count: 5 },
    };

    logAudit(db as unknown as D1Database, entry);
    await new Promise(r => setTimeout(r, 10));

    const params = db._calls[0].params;
    expect(params[7]).toBe(JSON.stringify({ old: true }));     // before_value
    expect(params[8]).toBe(JSON.stringify({ new: true, count: 5 })); // after_value
  });

  it('does not throw on DB error (fire-and-forget)', async () => {
    const db = makeMockDb();
    db._setShouldReject(true);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    expect(() => {
      logAudit(db as unknown as D1Database, {
        action: 'test.action',
      });
    }).not.toThrow();

    // Wait for rejection to be caught
    await new Promise(r => setTimeout(r, 50));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[audit] log failed:'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('sets actor_type default to user', async () => {
    const db = makeMockDb();
    logAudit(db as unknown as D1Database, {
      action: 'test.action',
      // actor_type NOT provided — should default to 'user'
    });
    await new Promise(r => setTimeout(r, 10));

    const params = db._calls[0].params;
    expect(params[2]).toBe('user'); // actor_type defaults to 'user'
  });

  it('uses ctx.waitUntil when ctx is provided', () => {
    const db = makeMockDb();
    const mockCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    logAudit(db as unknown as D1Database, {
      action: 'test.action',
    }, mockCtx);

    expect(mockCtx.waitUntil).toHaveBeenCalledTimes(1);
  });
});

// ── getAuditLog() tests (via DB queries) ─────────────────────

describe('getAuditLog()', () => {
  it('returns entries paginated', async () => {
    const mockEntries = [
      { id: 1, action: 'domain.add', created_at: 1000 },
      { id: 2, action: 'domain.remove', created_at: 2000 },
    ];
    const db = makeMockDb();
    db._setAllResult({ results: mockEntries });

    // Import getAuditLog separately
    const { getAuditLog } = await import('../../src/db/queries');
    const result = await getAuditLog(db as unknown as D1Database, { page: 1, limit: 50 });

    expect(result.results).toEqual(mockEntries);
    expect(db.prepare).toHaveBeenCalledTimes(1);
    const sql = db._calls[0].sql;
    expect(sql).toContain('LIMIT ? OFFSET ?');
    // params: limit, offset
    const params = db._calls[0].params;
    expect(params[0]).toBe(50);  // limit
    expect(params[1]).toBe(0);   // offset for page 1
  });

  it('filters by action prefix', async () => {
    const db = makeMockDb();
    db._setAllResult({ results: [] });

    const { getAuditLog } = await import('../../src/db/queries');
    await getAuditLog(db as unknown as D1Database, { action: 'dns' });

    const sql = db._calls[0].sql;
    expect(sql).toContain('action LIKE ?');
    const params = db._calls[0].params;
    // Should be 'dns%' (prefix match)
    expect(params).toContain('dns%');
  });

  it('filters by date range (since/until)', async () => {
    const db = makeMockDb();
    db._setAllResult({ results: [] });

    const { getAuditLog } = await import('../../src/db/queries');
    await getAuditLog(db as unknown as D1Database, { since: 1000, until: 2000 });

    const sql = db._calls[0].sql;
    expect(sql).toContain('created_at >= ?');
    expect(sql).toContain('created_at <= ?');
    const params = db._calls[0].params;
    expect(params).toContain(1000);
    expect(params).toContain(2000);
  });
});

// ── GET /api/audit-log route tests ───────────────────────────

describe('GET /api/audit-log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 for non-admin user', async () => {
    const db = makeMockDb();
    // getUserBySession → non-admin user, getUserByEmail → null, getSetting → auto_api_key
    // The first prepare().bind().first() returns a user (for session lookup)
    // We need to mock a user with role !== 'admin'
    let callIdx = 0;
    db.prepare.mockImplementation((sql: string) => {
      const call = { sql, params: [] as unknown[] };
      db._calls.push(call);
      return {
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          call.params = args;
          callIdx++;
          // Call patterns: getUserBySession → getSetting → requireAuth logic → getUserBySession (for audit-log)
          // The audit-log endpoint checks actor.role === 'admin'
          // We need getUserBySession to return a non-admin user
          let firstVal: unknown = null;
          if (sql.includes('FROM users') && sql.includes('session_token')) {
            firstVal = { id: 'user-1', email: 'user@test.com', role: 'member', session_token: 'test-key' };
          } else if (sql.includes('FROM settings')) {
            firstVal = { key: 'auto_api_key', value: 'test-key' };
          }
          return {
            run: vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
            first: vi.fn().mockResolvedValue(firstVal),
            all: vi.fn().mockResolvedValue({ results: [] }),
          };
        }),
        first: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
    });

    const env = makeEnv(db);
    // Remove API_KEY so it falls through to session-based auth
    delete (env as any).API_KEY;
    const res = await handleApi(
      req('GET', '/api/audit-log', undefined, { 'x-api-key': 'test-key' }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toContain('admin');
  });

  it('returns entries for admin user', async () => {
    const mockEntries = [
      { id: 1, action: 'domain.add', created_at: 1000 },
    ];
    const db = makeMockDb();
    let callIdx = 0;
    db.prepare.mockImplementation((sql: string) => {
      const call = { sql, params: [] as unknown[] };
      db._calls.push(call);
      return {
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          call.params = args;
          callIdx++;
          let firstVal: unknown = null;
          if (sql.includes('FROM users') && sql.includes('session_token')) {
            firstVal = { id: 'admin-1', email: 'admin@test.com', role: 'admin', session_token: 'test-key' };
          } else if (sql.includes('FROM settings')) {
            firstVal = { key: 'auto_api_key', value: 'test-key' };
          }
          return {
            run: vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
            first: vi.fn().mockResolvedValue(firstVal),
            all: sql.includes('audit_log')
              ? vi.fn().mockResolvedValue({ results: mockEntries })
              : vi.fn().mockResolvedValue({ results: [] }),
          };
        }),
        first: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
    });

    const env = makeEnv(db);
    delete (env as any).API_KEY;
    const res = await handleApi(
      req('GET', '/api/audit-log', undefined, { 'x-api-key': 'test-key' }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.entries).toEqual(mockEntries);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(50);
  });
});
