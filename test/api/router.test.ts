import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';
import type { Domain } from '../../src/db/types';

// Mock auth so all requests pass with customerId = 'org_test'
vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ customerId: 'org_test' }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

// Mock DNS provisioning so router tests don't hit Cloudflare
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'cf-rec-1', recordName: 'acme.com._report._dmarc.reports.inboxangel.io' }),
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
      }),
      batch: vi.fn().mockResolvedValue([]),
      ...dbOverrides,
    } as unknown as D1Database,
    AUTH0_DOMAIN: '',
    AUTH0_AUDIENCE: '',
    API_KEY: 'test-key',
    CLOUDFLARE_ACCOUNT_ID: '',
    CLOUDFLARE_ZONE_ID: '',
    CLOUDFLARE_API_TOKEN: '',
    REPORTS_DOMAIN: 'reports.inboxangel.io',
    FROM_EMAIL: 'check@reports.inboxangel.io',
  };
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ctx = {} as ExecutionContext;

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
    expect(body.email).toMatch(/^check-[^@]+@reports\.inboxangel\.io$/);
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
  it('returns empty domains array when customer has none', async () => {
    const res = await handleApi(req('GET', '/api/domains'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.domains).toEqual([]);
  });

  it('returns domain list from DB', async () => {
    const domain: Partial<Domain> = { id: 1, domain: 'acme.com', rua_address: 'x@reports.inboxangel.com' };
    const env = makeEnv();
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [domain] }) }),
    });
    const res = await handleApi(req('GET', '/api/domains'), env, ctx);
    const body = await res.json() as any;
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].domain).toBe('acme.com');
  });
});

// ── POST /api/domains ─────────────────────────────────────────

describe('POST /api/domains', () => {
  it('returns 201 with domain and rua_address', async () => {
    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), makeEnv(), ctx);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.domain).toBe('acme.com');
    expect(body.rua_address).toContain('@reports.inboxangel.io');
  });

  it('lowercases and trims the domain', async () => {
    const res = await handleApi(req('POST', '/api/domains', { domain: '  ACME.COM  ' }), makeEnv(), ctx);
    const body = await res.json() as any;
    expect(body.domain).toBe('acme.com');
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
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockRejectedValue(new Error('UNIQUE constraint failed')),
      }),
    });
    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), env, ctx);
    expect(res.status).toBe(409);
  });

  it('derives rua_address from customerId + domain slug', async () => {
    const res = await handleApi(req('POST', '/api/domains', { domain: 'my-company.io' }), makeEnv(), ctx);
    const body = await res.json() as any;
    expect(body.rua_address).toBe('org_test-my-company-io@reports.inboxangel.io');
  });

  it('returns 502 when DNS provisioning fails', async () => {
    vi.mocked(dnsMod.provisionDomain).mockRejectedValueOnce(
      new dnsMod.DnsProvisionError('Cloudflare rejected DNS record creation: auth error')
    );
    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), makeEnv(), ctx);
    expect(res.status).toBe(502);
  });

  it('includes auth_record in the 201 response', async () => {
    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), makeEnv(), ctx);
    const body = await res.json() as any;
    expect(body.auth_record).toContain('_report._dmarc.');
  });
});

// ── DELETE /api/domains/:id ───────────────────────────────────

describe('DELETE /api/domains/:id', () => {
  it('returns 204 when domain is owned by customer', async () => {
    const env = makeEnv();
    const domain: Partial<Domain> = { id: 5, domain: 'acme.com', customer_id: 'org_test', dns_record_id: null };
    (env.DB.prepare as any)
      .mockReturnValueOnce({ // getDomainById
        bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(domain) }),
      })
      .mockReturnValueOnce({ // DELETE
        bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) }),
      });
    const res = await handleApi(req('DELETE', '/api/domains/5'), env, ctx);
    expect(res.status).toBe(204);
  });

  it('calls deprovisionDomain when dns_record_id is set', async () => {
    const env = makeEnv();
    const domain: Partial<Domain> = { id: 5, domain: 'acme.com', customer_id: 'org_test', dns_record_id: 'cf-rec-abc' };
    (env.DB.prepare as any)
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(domain) }) })
      .mockReturnValueOnce({ bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) }) });
    await handleApi(req('DELETE', '/api/domains/5'), env, ctx);
    expect(dnsMod.deprovisionDomain).toHaveBeenCalledWith(expect.anything(), 'cf-rec-abc');
  });

  it('returns 404 when domain does not belong to customer', async () => {
    // getDomainById returns a domain owned by someone else
    const env = makeEnv();
    const otherDomain: Partial<Domain> = { id: 99, domain: 'other.com', customer_id: 'org_other' };
    (env.DB.prepare as any).mockReturnValueOnce({
      bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(otherDomain) }),
    });
    const res = await handleApi(req('DELETE', '/api/domains/99'), env, ctx);
    expect(res.status).toBe(404);
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
    // Second bind arg is the limit
    const limitArg = bindMock.mock.calls[0][1];
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
    const report = { id: 1, customer_id: 'org_test', domain: 'acme.com' };
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
  it('returns empty results when customer has no domains', async () => {
    const res = await handleApi(req('GET', '/api/check-results'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toEqual([]);
  });
});

afterEach(() => vi.clearAllMocks());
