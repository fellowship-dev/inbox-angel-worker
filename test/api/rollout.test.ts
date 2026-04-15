import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/index';
import type { Domain } from '../../src/db/types';

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test' }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

vi.mock('../../src/env-utils', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    enrichEnv: vi.fn().mockResolvedValue(undefined),
    getZoneId: vi.fn().mockReturnValue(undefined),
    getAccountId: vi.fn().mockReturnValue(undefined),
    reportsDomain: vi.fn().mockReturnValue('reports.example.com'),
    fromEmail: vi.fn().mockReturnValue('check@reports.example.com'),
    getWorkersSubdomain: vi.fn().mockReturnValue(undefined),
  };
});

vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'cf-1', recordName: 'acme.com._report._dmarc.reports.example.com', manual: false }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {
    constructor(msg: string) { super(msg); this.name = 'DnsProvisionError'; }
  },
}));

import { handleApi } from '../../src/api/router';

const BASE = 'https://api.example.com';
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

const domain: Partial<Domain> = {
  id: 5,
  domain: 'acme.com',
  rua_address: 'rua@reports.example.com',
  dmarc_policy: 'quarantine',
  dmarc_pct: 10,
  rollout_rec_policy: null,
  rollout_rec_pct: null,
};

function makeEnv(domainRow: Partial<Domain> | null = domain): Env {
  return {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run:   vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 5 } }),
          first: vi.fn().mockResolvedValue(domainRow),
          all:   vi.fn().mockResolvedValue({ results: [] }),
        }),
        first: vi.fn().mockResolvedValue(domainRow),
        all:   vi.fn().mockResolvedValue({ results: [] }),
      }),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database,
    API_KEY: 'test-key',
  } as Env;
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

// ── POST /api/domains/:id/rollout-advance ─────────────────────

describe('POST /api/domains/:id/rollout-advance', () => {
  it('returns 200 ok with persisted recommended step', async () => {
    const res = await handleApi(req('POST', '/api/domains/5/rollout-advance', { policy: 'quarantine', pct: 50 }), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.rollout_rec_policy).toBe('quarantine');
    expect(body.rollout_rec_pct).toBe(50);
  });

  it('returns 404 when domain not found', async () => {
    const res = await handleApi(req('POST', '/api/domains/999/rollout-advance', { policy: 'quarantine', pct: 10 }), makeEnv(null), ctx);
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid policy', async () => {
    const res = await handleApi(req('POST', '/api/domains/5/rollout-advance', { policy: 'none', pct: 10 }), makeEnv(), ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('quarantine or reject');
  });

  it('returns 400 for invalid pct', async () => {
    const res = await handleApi(req('POST', '/api/domains/5/rollout-advance', { policy: 'quarantine', pct: 75 }), makeEnv(), ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('pct must be 10, 50, or 100');
  });

  it('returns 400 for invalid domain id', async () => {
    const res = await handleApi(req('POST', '/api/domains/abc/rollout-advance', { policy: 'quarantine', pct: 10 }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });
});
