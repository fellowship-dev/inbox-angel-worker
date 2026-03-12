import { describe, it, expect, vi } from 'vitest';
import { resolveDomain } from '../../src/email/resolve-domain';
import type { Domain } from '../../src/db/types';

// ── Fixtures ──────────────────────────────────────────────────

const DOMAIN: Domain = {
  id: 1,
  domain: 'acme.com',
  rua_address: 'rua@reports.inboxangel.io',
  dmarc_policy: 'quarantine',
  dmarc_pct: 100,
  spf_record: 'v=spf1 -all',
  auth_record_provisioned: 1,
  dns_record_id: null,
  spf_lookup_count: null,
  created_at: 1700000000,
  updated_at: 1700000000,
};

// Build a mock D1Database that returns given domain row
function makeDb(domain: Domain | null): D1Database {
  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(domain),
      }),
    })),
  } as unknown as D1Database;
}

// ── Tests ─────────────────────────────────────────────────────

describe('resolveDomain', () => {
  it('returns domain for a known policy domain', async () => {
    const db = makeDb(DOMAIN);
    const result = await resolveDomain(db, 'acme.com');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.domain).toBe('acme.com');
  });

  it('returns null when domain is not in domains table', async () => {
    const db = makeDb(null);
    const result = await resolveDomain(db, 'unknown.com');
    expect(result).toBeNull();
  });

  it('normalises the policy domain to lowercase before lookup', async () => {
    const db = makeDb(DOMAIN);
    const result = await resolveDomain(db, 'ACME.COM');

    expect(result).not.toBeNull();
    const prepareMock = db.prepare as ReturnType<typeof vi.fn>;
    const domainQuery = prepareMock.mock.calls.find(([sql]: [string]) =>
      sql.includes('domains')
    );
    expect(domainQuery).toBeDefined();
    const bindArg = prepareMock.mock.results[
      prepareMock.mock.calls.indexOf(domainQuery)
    ].value.bind.mock.calls[0][0];
    expect(bindArg).toBe('acme.com');
  });

  it('preserves all domain fields in the result', async () => {
    const db = makeDb(DOMAIN);
    const result = await resolveDomain(db, 'acme.com');
    expect(result).toEqual(DOMAIN);
  });

  it('returns different domains for different lookups', async () => {
    const domain2: Domain = { ...DOMAIN, id: 2, domain: 'acme.io', rua_address: 'rua@reports.inboxangel.io' };
    const db = makeDb(domain2);
    const result = await resolveDomain(db, 'acme.io');

    expect(result!.domain).toBe('acme.io');
    expect(result!.id).toBe(2);
  });
});
