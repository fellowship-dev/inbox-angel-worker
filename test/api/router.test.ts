import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';
import type { Domain } from '../../src/db/types';

// Mock auth so all requests pass with userId = 'org_test'
vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test' }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

// Mock env-utils so enrichEnv is a no-op (avoids extra DB calls that break mock ordering)
vi.mock('../../src/env-utils', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    enrichEnv: vi.fn().mockResolvedValue(undefined),
    getZoneId: vi.fn().mockReturnValue(undefined),
    getAccountId: vi.fn().mockReturnValue(undefined),
    reportsDomain: vi.fn().mockReturnValue('reports.inboxangel.io'),
    fromEmail: vi.fn().mockReturnValue('check@reports.inboxangel.io'),
    getWorkersSubdomain: vi.fn().mockReturnValue(undefined),
  };
});

// Mock DNS provisioning so router tests don't hit Cloudflare
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'cf-rec-1', recordName: 'acme.com._report._dmarc.reports.inboxangel.io', manual: false }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {
    constructor(msg: string) { super(msg); this.name = 'DnsProvisionError'; }
  },
}));

import { handleApi } from '../../src/api/router';
import * as authMod from '../../src/api/auth';
import * as dnsMod from '../../src/dns/provision';

// ── Helpers ───────────────────────────────────────────────────

const BASE = 'https://api.inboxangel.com';

function makeEnv(dbOverrides: Partial<{ prepare: any; batch: any }> = {}): Env {
  return {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run:   vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
          first: vi.fn().mockResolvedValue(null),
          all:   vi.fn().mockResolvedValue({ results: [] }),
        }),
        // For direct prepare().first() or prepare().all() calls (no bind)
        first: vi.fn().mockResolvedValue(null),
        all:   vi.fn().mockResolvedValue({ results: [] }),
      }),
      batch: vi.fn().mockResolvedValue([]),
      ...dbOverrides,
    } as unknown as D1Database,
    API_KEY: 'test-key',
    CLOUDFLARE_ACCOUNT_ID: '',
    CLOUDFLARE_ZONE_ID: '',
    CLOUDFLARE_API_TOKEN: '',
    REPORTS_DOMAIN: 'reports.inboxangel.io',
    FROM_EMAIL: 'check@reports.inboxangel.io',
  };
}

function req(method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = { 'x-api-key': 'test-key' };
  if (body) headers['content-type'] = 'application/json';
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

// ── /health ───────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 ok without auth', async () => {
    const res = await handleApi(req('GET', '/health'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(authMod.requireAuth).not.toHaveBeenCalled();
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
  });

  it('includes a ts timestamp', async () => {
    const res = await handleApi(req('GET', '/health'), makeEnv(), ctx);
    const body = await res.json() as any;
    expect(typeof body.ts).toBe('number');
  });

  it('includes semver version string', async () => {
    const res = await handleApi(req('GET', '/health'), makeEnv(), ctx);
    const body = await res.json() as any;
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ── 404 for unknown paths ─────────────────────────────────────

describe('unknown routes', () => {
  it('returns 404 for non-api path', async () => {
    const res = await handleApi(req('GET', '/unknown'), makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown /api/ sub-path', async () => {
    const res = await handleApi(req('GET', '/api/unknown'), makeEnv(), ctx);
    expect(res.status).toBe(404);
  });
});

// ── Free check sessions (public, unauthenticated) ─────────────

describe('POST /api/check-sessions', () => {
  it('returns 201 with token and email', async () => {
    const res = await handleApi(req('POST', '/api/check-sessions'), makeEnv(), ctx);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(typeof body.token).toBe('string');
    // Token is used directly as the local-part (no check- prefix)
    expect(body.email).toMatch(/^[a-z0-9]+@reports\.inboxangel\.io$/);
  });

  it('generates a unique token each call', async () => {
    const [a, b] = await Promise.all([
      handleApi(req('POST', '/api/check-sessions'), makeEnv(), ctx).then(r => r.json()) as any,
      handleApi(req('POST', '/api/check-sessions'), makeEnv(), ctx).then(r => r.json()) as any,
    ]);
    expect((a as any).token).not.toBe((b as any).token);
  });

  it('does not call requireAuth', async () => {
    await handleApi(req('POST', '/api/check-sessions'), makeEnv(), ctx);
    expect(authMod.requireAuth).not.toHaveBeenCalled();
  });
});

describe('GET /api/check-sessions/:token', () => {
  it('returns 202 pending when no result yet', async () => {
    const res = await handleApi(req('GET', '/api/check-sessions/abc123'), makeEnv(), ctx);
    expect(res.status).toBe(202);
    const body = await res.json() as any;
    expect(body.status).toBe('pending');
  });

  it('returns 200 done when result exists', async () => {
    const env = makeEnv();
    const result = { id: 1, session_token: 'abc123', overall_status: 'protected' };
    (env.DB.prepare as any).mockReturnValueOnce({
      bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(result) }),
    });
    const res = await handleApi(req('GET', '/api/check-sessions/abc123'), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('done');
    expect(body.result.overall_status).toBe('protected');
  });

  it('does not call requireAuth', async () => {
    await handleApi(req('GET', '/api/check-sessions/abc123'), makeEnv(), ctx);
    expect(authMod.requireAuth).not.toHaveBeenCalled();
  });
});

// ── Auth failure propagation ──────────────────────────────────

describe('auth failure', () => {
  it('returns 401 when requireAuth throws AuthError', async () => {
    vi.mocked(authMod.requireAuth).mockRejectedValueOnce(
      new authMod.AuthError('Missing Authorization')
    );
    const res = await handleApi(req('GET', '/api/domains'), makeEnv(), ctx);
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toContain('Missing Authorization');
  });

  it('returns 403 when AuthError has status 403', async () => {
    vi.mocked(authMod.requireAuth).mockRejectedValueOnce(
      new authMod.AuthError('audience mismatch', 403)
    );
    const res = await handleApi(req('GET', '/api/domains'), makeEnv(), ctx);
    expect(res.status).toBe(403);
  });
});

// ── GET /api/domains ──────────────────────────────────────────

describe('GET /api/domains', () => {
  it('returns empty domains array when none exist', async () => {
    const res = await handleApi(req('GET', '/api/domains'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.domains).toEqual([]);
  });

  it('returns domain list from DB', async () => {
    const domain: Partial<Domain> = { id: 1, domain: 'acme.com', rua_address: 'x@reports.inboxangel.com' };
    const env = makeEnv();
    (env.DB.prepare as any).mockReturnValue({
      all: vi.fn().mockResolvedValue({ results: [domain] }),
      bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [domain] }) }),
    });
    const res = await handleApi(req('GET', '/api/domains'), env, ctx);
    const body = await res.json() as any;
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].domain).toBe('acme.com');
  });
});

// ── POST /api/domains ─────────────────────────────────────────
// addDomain flow: insertDomain → logAudit (fire-and-forget) → getDomainById
// Response shape: { domain: <domainRow>, rua_hint, auth_record }

describe('POST /api/domains', () => {
  it('returns 201 with domain row and rua_hint', async () => {
    const domainRow: Partial<Domain> = { id: 1, domain: 'acme.com', rua_address: 'rua@reports.inboxangel.io'};
    const env = makeEnv();
    // getAllDomains → empty at first
    // insertDomain, logAudit all use default mock
    // getDomainById needs to return the domain row
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run:   vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
        first: vi.fn().mockResolvedValue(domainRow),
        all:   vi.fn().mockResolvedValue({ results: [] }),
      }),
    });
    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), env, ctx);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.domain.domain).toBe('acme.com');
    expect(body.rua_hint).toContain('rua=mailto:rua@reports.inboxangel.io');
  });

  it('lowercases and trims the domain', async () => {
    const domainRow: Partial<Domain> = { id: 1, domain: 'acme.com', rua_address: 'rua@reports.inboxangel.io'};
    const env = makeEnv();
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run:   vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
        first: vi.fn().mockResolvedValue(domainRow),
        all:   vi.fn().mockResolvedValue({ results: [] }),
      }),
    });
    const res = await handleApi(req('POST', '/api/domains', { domain: '  ACME.COM  ' }), env, ctx);
    const body = await res.json() as any;
    expect(body.domain.domain).toBe('acme.com');
  });

  it('returns 400 when domain is missing', async () => {
    const res = await handleApi(req('POST', '/api/domains', {}), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid domain format', async () => {
    const res = await handleApi(req('POST', '/api/domains', { domain: 'not-a-domain' }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid JSON body', async () => {
    const r = new Request(`${BASE}/api/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await handleApi(r, makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate domain', async () => {
    const env = makeEnv();
    // insertDomain throws UNIQUE (no DNS provisioning on domain add anymore)
    (env.DB.prepare as any)
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({
        run: vi.fn().mockRejectedValue(new Error('UNIQUE constraint failed')),
      }) });
    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), env, ctx);
    expect(res.status).toBe(409);
  });

  it('uses fixed rua address rua@REPORTS_DOMAIN', async () => {
    const domainRow: Partial<Domain> = { id: 1, domain: 'my-company.io', rua_address: 'rua@reports.inboxangel.io'};
    const env = makeEnv();
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run:   vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
        first: vi.fn().mockResolvedValue(domainRow),
        all:   vi.fn().mockResolvedValue({ results: [] }),
      }),
    });
    const res = await handleApi(req('POST', '/api/domains', { domain: 'my-company.io' }), env, ctx);
    const body = await res.json() as any;
    expect(body.rua_hint).toContain('rua=mailto:rua@reports.inboxangel.io');
  });

  it('does not call provisionDomain on domain add (DNS deferred to wizard)', async () => {
    const domainRow: Partial<Domain> = { id: 1, domain: 'acme.com', rua_address: 'rua@reports.inboxangel.io'};
    const env = makeEnv();
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run:   vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
        first: vi.fn().mockResolvedValue(domainRow),
        all:   vi.fn().mockResolvedValue({ results: [] }),
      }),
    });
    await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), env, ctx);
    expect(dnsMod.provisionDomain).not.toHaveBeenCalled();
  });

  it('includes auth_record in the 201 response', async () => {
    const domainRow: Partial<Domain> = { id: 1, domain: 'acme.com', rua_address: 'rua@reports.inboxangel.io'};
    const env = makeEnv();
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run:   vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
        first: vi.fn().mockResolvedValue(domainRow),
        all:   vi.fn().mockResolvedValue({ results: [] }),
      }),
    });
    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), env, ctx);
    const body = await res.json() as any;
    expect(body.auth_record).toContain('_report._dmarc.');
  });

  it('always returns dns_instructions for manual setup (no auto-provisioning)', async () => {
    const domainRow: Partial<Domain> = { id: 1, domain: 'acme.com', rua_address: 'rua@reports.inboxangel.io'};
    const env = makeEnv();
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run:   vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
        first: vi.fn().mockResolvedValue(domainRow),
        all:   vi.fn().mockResolvedValue({ results: [] }),
      }),
    });
    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), env, ctx);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.dns_instructions).toContain('v=DMARC1;');
    expect(body.auth_record).toContain('_report._dmarc.');
  });
});

// ── Self-hosted lazy init ──────────────────────────────────────

describe('BASE_DOMAIN lazy init', () => {
  it('creates domain DB row on first authenticated request (no DNS writes)', async () => {
    const env = { ...makeEnv(), BASE_DOMAIN: 'myco.com' };
    // ensureInitialized flow (no DNS provisioning):
    // 1. getAllDomains → empty
    // 2. insertDomain
    (env.DB.prepare as any)
      .mockReturnValueOnce({ all: vi.fn().mockResolvedValue({ results: [] }) }) // getAllDomains (no bind)
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }) }) }); // insertDomain
    // Actual handler: GET /api/domains → getAllDomains again
    (env.DB.prepare as any).mockReturnValue({
      all: vi.fn().mockResolvedValue({ results: [] }),
    });
    const res = await handleApi(req('GET', '/api/domains'), env, ctx);
    expect(res.status).toBe(200);
    expect(dnsMod.provisionDomain).not.toHaveBeenCalled();
  });

  it('skips lazy init when BASE_DOMAIN is not set', async () => {
    const env = makeEnv(); // no BASE_DOMAIN
    await handleApi(req('GET', '/api/domains'), env, ctx);
    expect(dnsMod.provisionDomain).not.toHaveBeenCalled();
  });
});

// ── DELETE /api/domains/:id ───────────────────────────────────

describe('DELETE /api/domains/:id', () => {
  it('returns 204 when domain exists', async () => {
    const env = makeEnv();
    const domain: Partial<Domain> = { id: 5, domain: 'acme.com',  dns_record_id: null };
    (env.DB.prepare as any)
      .mockReturnValueOnce({ // getDomainById
        bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(domain) }),
      });
    // DELETE + logAudit use the default mock (which handles bind().run())
    const res = await handleApi(req('DELETE', '/api/domains/5'), env, ctx);
    expect(res.status).toBe(204);
  });

  it('calls deprovisionDomain when dns_record_id is set', async () => {
    const env = makeEnv();
    const domain: Partial<Domain> = { id: 5, domain: 'acme.com',  dns_record_id: 'cf-rec-abc' };
    (env.DB.prepare as any)
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(domain) }) });
    // DELETE + logAudit (x2) use the default mock
    await handleApi(req('DELETE', '/api/domains/5'), env, ctx);
    expect(dnsMod.deprovisionDomain).toHaveBeenCalledWith(expect.anything(), 'cf-rec-abc');
  });

  it('returns 404 when domain not found', async () => {
    const env = makeEnv(); // first() returns null by default
    const res = await handleApi(req('DELETE', '/api/domains/99'), env, ctx);
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric id', async () => {
    const res = await handleApi(req('DELETE', '/api/domains/abc'), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });
});

// ── GET /api/domains/:id/stats ────────────────────────────────

describe('GET /api/domains/:id/stats', () => {
  it('returns stats for owned domain', async () => {
    const env = makeEnv();
    const domain: Partial<Domain> = { id: 1, domain: 'acme.com' };
    const stats = [{ day: '2026-03-01', total: 100, passed: 95, failed: 5 }];
    (env.DB.prepare as any)
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(domain) }) })
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: stats }) }) });
    const res = await handleApi(req('GET', '/api/domains/1/stats'), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.domain).toBe('acme.com');
    expect(body.stats).toEqual(stats);
    expect(body.days).toBe(30);
  });

  it('returns 400 for non-numeric domain id', async () => {
    const res = await handleApi(req('GET', '/api/domains/abc/stats'), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('defaults to 30 days and caps at 90', async () => {
    const env = makeEnv();
    const domain: Partial<Domain> = { id: 1, domain: 'acme.com' };
    (env.DB.prepare as any)
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(domain) }) })
      .mockReturnValue({ bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) }) });
    const res = await handleApi(req('GET', '/api/domains/1/stats?days=999'), env, ctx);
    const body = await res.json() as any;
    expect(body.days).toBe(90);
  });
});

// ── GET /api/reports ──────────────────────────────────────────

describe('GET /api/reports', () => {
  it('returns reports array', async () => {
    const res = await handleApi(req('GET', '/api/reports'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.reports)).toBe(true);
  });

  it('caps limit at 100', async () => {
    const env = makeEnv();
    const bindMock = vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) });
    (env.DB.prepare as any).mockReturnValue({ bind: bindMock });
    await handleApi(req('GET', '/api/reports?limit=999'), env, ctx);
    // First (only) bind arg is the capped limit
    const limitArg = bindMock.mock.calls[0][0];
    expect(limitArg).toBe(100);
  });
});

// ── GET /api/reports/:id ──────────────────────────────────────

describe('GET /api/reports/:id', () => {
  it('returns 404 when report not found', async () => {
    const res = await handleApi(req('GET', '/api/reports/999'), makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric id', async () => {
    const res = await handleApi(req('GET', '/api/reports/abc'), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns report + records when found', async () => {
    const env = makeEnv();
    const report = { id: 1,  domain: 'acme.com' };
    (env.DB.prepare as any)
      .mockReturnValueOnce({ // aggregate_reports query
        bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(report) }),
      })
      .mockReturnValueOnce({ // report_records query
        bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) }),
      });
    const res = await handleApi(req('GET', '/api/reports/1'), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.report.id).toBe(1);
    expect(Array.isArray(body.records)).toBe(true);
  });
});

// ── POST /api/monitor ─────────────────────────────────────────

describe('POST /api/monitor', () => {
  const checkResult = { id: 1, from_domain: 'acme.com', spf_record: 'v=spf1 -all', dmarc_policy: 'none', dmarc_record: 'v=DMARC1; p=none', session_token: 'tok123' };

  it('returns 201 with domain and email when session exists', async () => {
    const env = makeEnv();
    (env.DB.prepare as any)
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(checkResult) }) }) // getCheckResultByToken
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) }) }); // insertMonitorSubscription
    const res = await handleApi(req('POST', '/api/monitor', { email: 'user@example.com', session_token: 'tok123' }), env, ctx);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.domain).toBe('acme.com');
    expect(body.email).toBe('user@example.com');
  });

  it('returns 400 when email is missing', async () => {
    const res = await handleApi(req('POST', '/api/monitor', { session_token: 'tok123' }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 when session_token is missing', async () => {
    const res = await handleApi(req('POST', '/api/monitor', { email: 'user@example.com' }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid email format', async () => {
    const res = await handleApi(req('POST', '/api/monitor', { email: 'notanemail', session_token: 'tok' }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 404 when session token has no check result', async () => {
    const res = await handleApi(req('POST', '/api/monitor', { email: 'user@example.com', session_token: 'unknown' }), makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  it('does not require auth', async () => {
    const env = makeEnv();
    (env.DB.prepare as any)
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(checkResult) }) })
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) }) });
    await handleApi(req('POST', '/api/monitor', { email: 'u@x.com', session_token: 'tok123' }), env, ctx);
    expect(authMod.requireAuth).not.toHaveBeenCalled();
  });
});

// ── GET /api/check-results ────────────────────────────────────

describe('GET /api/check-results', () => {
  it('returns empty results when no domains exist', async () => {
    const res = await handleApi(req('GET', '/api/check-results'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toEqual([]);
  });
});

// ── Wizard state endpoints ────────────────────────────────────

describe('GET /api/domains/:id/wizard-state', () => {
  it('returns default state when no wizard state saved', async () => {
    const env = makeEnv();
    const domain: Partial<Domain> = { id: 1, domain: 'acme.com'};
    (env.DB.prepare as any)
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(domain) }) }) // getDomainById
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }); // getSetting (no saved state)
    const res = await handleApi(req('GET', '/api/domains/1/wizard-state'), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.spf).toBe('not_started');
    expect(body.dkim).toBe('not_started');
    expect(body.dmarc).toBe('not_started');
    expect(body.routing).toBe('not_started');
  });

  it('returns saved wizard state', async () => {
    const env = makeEnv();
    const domain: Partial<Domain> = { id: 1, domain: 'acme.com' };
    const savedState = { spf: 'complete', dkim: 'skipped', dmarc: 'not_started', routing: 'not_started' };
    (env.DB.prepare as any)
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(domain) }) })
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ value: JSON.stringify(savedState) }) }) });
    const res = await handleApi(req('GET', '/api/domains/1/wizard-state'), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.spf).toBe('complete');
    expect(body.dkim).toBe('skipped');
  });

  it('returns 400 for non-numeric id', async () => {
    const res = await handleApi(req('GET', '/api/domains/abc/wizard-state'), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/domains/:id/wizard-state', () => {
  it('saves wizard state updates', async () => {
    const env = makeEnv();
    const domain: Partial<Domain> = { id: 1, domain: 'acme.com' };
    (env.DB.prepare as any)
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(domain) }) }) // getDomainById
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }); // getSetting (current state)
    // setSetting uses default mock
    const res = await handleApi(req('PUT', '/api/domains/1/wizard-state', { spf: 'complete' }), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.spf).toBe('complete');
    expect(body.dkim).toBe('not_started');
  });

});

// ── Subdomain support (T017 + T018) ──────────────────────────
// T017: insertDomain auto-detects parent_id from existing domains
// T018: POST /api/domains with subdomain returns parent_context

describe('POST /api/domains — subdomain parent_context (T018)', () => {
  // Mock lookupDmarc so no real DNS is called
  vi.mock('../../src/email/dns-check', async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
      ...actual,
      lookupDmarc: vi.fn().mockResolvedValue({ policy: 'reject', subdomainPolicy: 'reject', pct: 100, rua: [], ruf: [], raw: 'v=DMARC1; p=reject; sp=reject' }),
      lookupSpf: vi.fn().mockResolvedValue(null),
    };
  });

  it('returns parent_context when subdomain is added and parent exists in DB', async () => {
    const parentRow: Partial<Domain> = { id: 1, domain: 'acme.com', rua_address: 'rua@reports.inboxangel.io', parent_id: null };
    const subdomainRow: Partial<Domain> = { id: 2, domain: 'marketing.acme.com', rua_address: 'rua@reports.inboxangel.io', parent_id: 1 };
    const env = makeEnv();

    let callCount = 0;
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 2 } }),
        first: vi.fn().mockImplementation(() => {
          callCount++;
          // 1st first() = parent lookup in insertDomain (SELECT id FROM domains WHERE domain = 'acme.com')
          // 2nd first() = getDomainById for subdomainRow
          // 3rd first() = getDomainById for parentRow (parent_context fetch)
          if (callCount === 1) return Promise.resolve(parentRow);
          if (callCount === 2) return Promise.resolve(subdomainRow);
          return Promise.resolve(parentRow);
        }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    }));

    const res = await handleApi(req('POST', '/api/domains', { domain: 'marketing.acme.com' }), env, ctx);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.domain.domain).toBe('marketing.acme.com');
    expect(body.parent_context).toBeDefined();
    expect(body.parent_context.domain).toBe('acme.com');
    expect(body.parent_context.has_dmarc).toBe(true);
  });

  it('returns no parent_context when apex domain is added', async () => {
    const domainRow: Partial<Domain> = { id: 1, domain: 'acme.com', rua_address: 'rua@reports.inboxangel.io', parent_id: null };
    const env = makeEnv();
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
        first: vi.fn().mockResolvedValue(domainRow),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    });

    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), env, ctx);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.parent_context).toBeUndefined();
  });
});

afterEach(() => vi.clearAllMocks());
