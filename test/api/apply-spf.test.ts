import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/index';
import type { Domain } from '../../src/db/types';

// Mock auth
vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test' }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

// Mock DNS provisioning (router imports it)
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'cf-rec-1', recordName: 'test', manual: false }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {
    constructor(msg: string) { super(msg); this.name = 'DnsProvisionError'; }
  },
}));

// Mock env-utils so getZoneId returns a zone ID
vi.mock('../../src/env-utils', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getZoneId: vi.fn().mockReturnValue('zone-test-123'),
    getAccountId: vi.fn().mockReturnValue('acct-test'),
    reportsDomain: vi.fn().mockReturnValue('reports.test.com'),
    fromEmail: vi.fn().mockReturnValue('noreply@reports.test.com'),
    getWorkersSubdomain: vi.fn().mockReturnValue('testworker'),
  };
});

import { handleApi } from '../../src/api/router';
import { getZoneId } from '../../src/env-utils';

const BASE = 'https://api.inboxangel.com';
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

const DOMAIN: Partial<Domain> = {
  id: 1,
  domain: 'acme.com',
  rua_address: 'rua@reports.test.com',
  spf_record: 'v=spf1 include:_spf.google.com ~all',
  spf_lookup_count: 3,
};

function makeEnv(overrides: { cfToken?: string; flattenEnabled?: boolean } = {}): Env {
  const { cfToken = 'cf-token-abc', flattenEnabled = false } = overrides;

  // Track SQL queries to route mocks
  const prepareMock = vi.fn((sql: string) => {
    const stmt = {
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
        first: vi.fn().mockImplementation(() => {
          // getDomainById
          if (sql.includes('domains') && sql.includes('WHERE') && sql.includes('id')) {
            return Promise.resolve(DOMAIN);
          }
          // getSpfFlattenConfig
          if (sql.includes('spf_flatten_config')) {
            return Promise.resolve(flattenEnabled ? { enabled: 1, domain_id: 1 } : null);
          }
          // getUserBySession / settings
          if (sql.includes('users') || sql.includes('sessions')) {
            return Promise.resolve({ id: 1, email: 'admin@acme.com' });
          }
          return Promise.resolve(null);
        }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    return stmt;
  });

  return {
    DB: { prepare: prepareMock, batch: vi.fn().mockResolvedValue([]) } as unknown as D1Database,
    AUTH0_DOMAIN: '',
    AUTH0_AUDIENCE: '',
    API_KEY: 'test-key',
    CLOUDFLARE_ACCOUNT_ID: 'acct-test',
    CLOUDFLARE_ZONE_ID: 'zone-test-123',
    CLOUDFLARE_API_TOKEN: cfToken,
    REPORTS_DOMAIN: 'reports.test.com',
    FROM_EMAIL: 'noreply@reports.test.com',
  };
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

function mockFetch(searchResult: unknown[], cfSuccess = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn()
    // First call: search for existing SPF TXT records
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: searchResult }), { status: 200 }))
    // Second call: create or update
    .mockResolvedValueOnce(new Response(JSON.stringify({
      success: cfSuccess,
      result: { id: 'dns-rec-new' },
      ...(cfSuccess ? {} : { errors: [{ message: 'CF error' }] }),
    }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(getZoneId).mockReturnValue('zone-test-123');
});

// ── POST /api/domains/:id/apply-spf ──────────────────────────

describe('POST /api/domains/:id/apply-spf', () => {
  it('creates a new SPF record when none exists', async () => {
    const fetchMock = mockFetch([]); // no existing records
    const env = makeEnv();
    const res = await handleApi(
      req('POST', '/api/domains/1/apply-spf', { record: 'v=spf1 include:_spf.google.com ~all' }),
      env, ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.record).toBe('v=spf1 include:_spf.google.com ~all');
    expect(body.created).toBe(true);

    // Verify CF API POST call (second fetch call = create)
    const [url, opts] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone-test-123/dns_records');
    expect(opts.method).toBe('POST');
    const payload = JSON.parse(opts.body as string);
    expect(payload.type).toBe('TXT');
    expect(payload.name).toBe('acme.com');
    expect(payload.content).toBe('v=spf1 include:_spf.google.com ~all');
  });

  it('patches existing SPF record', async () => {
    const fetchMock = mockFetch([{ id: 'existing-spf-id', content: 'v=spf1 include:old.com ~all' }]);
    const env = makeEnv();
    const res = await handleApi(
      req('POST', '/api/domains/1/apply-spf', { record: 'v=spf1 include:_spf.google.com include:sendgrid.net ~all' }),
      env, ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.created).toBe(false);

    // Verify PATCH to existing record
    const [url, opts] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone-test-123/dns_records/existing-spf-id');
    expect(opts.method).toBe('PATCH');
  });

  it('returns 400 when record is missing', async () => {
    const res = await handleApi(
      req('POST', '/api/domains/1/apply-spf', {}),
      makeEnv(), ctx,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('record content is required');
  });

  it('returns 400 when record does not start with v=spf1', async () => {
    const res = await handleApi(
      req('POST', '/api/domains/1/apply-spf', { record: 'include:_spf.google.com ~all' }),
      makeEnv(), ctx,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('must start with v=spf1');
  });

  it('returns 400 when record has no all mechanism', async () => {
    const res = await handleApi(
      req('POST', '/api/domains/1/apply-spf', { record: 'v=spf1 include:_spf.google.com' }),
      makeEnv(), ctx,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('must end with an all mechanism');
  });

  it('returns 409 when SPF flattening is active', async () => {
    mockFetch([]);
    const env = makeEnv({ flattenEnabled: true });
    const res = await handleApi(
      req('POST', '/api/domains/1/apply-spf', { record: 'v=spf1 include:_spf.google.com ~all' }),
      env, ctx,
    );
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toContain('flattening is active');
  });

  it('returns 400 when CF credentials are missing', async () => {
    const env = makeEnv({ cfToken: '' });
    const res = await handleApi(
      req('POST', '/api/domains/1/apply-spf', { record: 'v=spf1 include:_spf.google.com ~all' }),
      env, ctx,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('Cloudflare credentials');
  });

  it('returns 400 for invalid domain id', async () => {
    const res = await handleApi(
      req('POST', '/api/domains/abc/apply-spf', { record: 'v=spf1 include:_spf.google.com ~all' }),
      makeEnv(), ctx,
    );
    expect(res.status).toBe(400);
  });

  it('returns 500 when CF API fails', async () => {
    mockFetch([], false); // CF returns success: false
    const env = makeEnv();
    const res = await handleApi(
      req('POST', '/api/domains/1/apply-spf', { record: 'v=spf1 include:_spf.google.com ~all' }),
      env, ctx,
    );
    expect(res.status).toBe(500);
  });

  it('sends correct Authorization header to CF API', async () => {
    const fetchMock = mockFetch([]);
    const env = makeEnv();
    await handleApi(
      req('POST', '/api/domains/1/apply-spf', { record: 'v=spf1 include:_spf.google.com ~all' }),
      env, ctx,
    );
    // First fetch = search, check its auth header
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer cf-token-abc');
  });

  it('supports -all qualifier', async () => {
    mockFetch([]);
    const env = makeEnv();
    const res = await handleApi(
      req('POST', '/api/domains/1/apply-spf', { record: 'v=spf1 include:_spf.google.com -all' }),
      env, ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.record).toBe('v=spf1 include:_spf.google.com -all');
  });

  it('finds existing SPF among multiple TXT records', async () => {
    const fetchMock = mockFetch([
      { id: 'txt-1', content: 'google-site-verification=abc123' },
      { id: 'txt-2', content: 'v=spf1 include:old.com ~all' },
      { id: 'txt-3', content: 'some-other-txt' },
    ]);
    const env = makeEnv();
    const res = await handleApi(
      req('POST', '/api/domains/1/apply-spf', { record: 'v=spf1 include:_spf.google.com ~all' }),
      env, ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.created).toBe(false);

    // Should PATCH txt-2 (the SPF record)
    const [url] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('txt-2');
  });
});
