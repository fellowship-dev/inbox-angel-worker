import { describe, it, expect, vi } from 'vitest';
import { resolveCustomer } from '../../src/email/resolve-customer';
import type { Customer, Domain } from '../../src/db/types';

// ── Fixtures ──────────────────────────────────────────────────

const CUSTOMER: Customer = {
  id: 'org_abc123',
  name: 'Acme Corp',
  email: 'admin@acme.com',
  plan: 'starter',
  created_at: 1700000000,
  updated_at: 1700000000,
};

const DOMAIN: Domain = {
  id: 1,
  customer_id: 'org_abc123',
  domain: 'acme.com',
  rua_address: 'rua@reports.inboxangel.io',
  dmarc_policy: 'quarantine',
  dmarc_pct: 100,
  spf_record: 'v=spf1 -all',
  dkim_configured: 1,
  auth_record_provisioned: 1,
  created_at: 1700000000,
  updated_at: 1700000000,
};

// Build a mock D1Database that returns given domain + customer rows
function makeDb(domain: Domain | null, customer: Customer | null): D1Database {
  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(
          sql.includes('domains') ? domain : customer
        ),
      }),
    })),
  } as unknown as D1Database;
}

// ── Tests ─────────────────────────────────────────────────────

describe('resolveCustomer', () => {
  it('returns customer and domain for a known policy domain', async () => {
    const db = makeDb(DOMAIN, CUSTOMER);
    const result = await resolveCustomer(db, 'acme.com');

    expect(result).not.toBeNull();
    expect(result!.customer.id).toBe('org_abc123');
    expect(result!.customer.name).toBe('Acme Corp');
    expect(result!.domain.domain).toBe('acme.com');
  });

  it('returns null when domain is not in domains table', async () => {
    const db = makeDb(null, CUSTOMER);
    const result = await resolveCustomer(db, 'unknown.com');
    expect(result).toBeNull();
  });

  it('returns null when domain exists but customer row is missing (orphaned domain)', async () => {
    const db = makeDb(DOMAIN, null);
    const result = await resolveCustomer(db, 'acme.com');
    expect(result).toBeNull();
  });

  it('normalises the policy domain to lowercase before lookup', async () => {
    const db = makeDb(DOMAIN, CUSTOMER);
    const result = await resolveCustomer(db, 'ACME.COM');

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

  it('uses domain.customer_id to fetch the customer', async () => {
    const db = makeDb(DOMAIN, CUSTOMER);
    await resolveCustomer(db, 'acme.com');

    const prepareMock = db.prepare as ReturnType<typeof vi.fn>;
    const customerQuery = prepareMock.mock.calls.find(([sql]: [string]) =>
      sql.includes('customers')
    );
    expect(customerQuery).toBeDefined();
    const bindArg = prepareMock.mock.results[
      prepareMock.mock.calls.indexOf(customerQuery)
    ].value.bind.mock.calls[0][0];
    expect(bindArg).toBe('org_abc123');
  });

  it('preserves all customer fields in the result', async () => {
    const db = makeDb(DOMAIN, CUSTOMER);
    const result = await resolveCustomer(db, 'acme.com');
    expect(result!.customer).toEqual(CUSTOMER);
  });

  it('preserves all domain fields in the result', async () => {
    const db = makeDb(DOMAIN, CUSTOMER);
    const result = await resolveCustomer(db, 'acme.com');
    expect(result!.domain).toEqual(DOMAIN);
  });

  it('handles a second domain on the same customer', async () => {
    const domain2: Domain = { ...DOMAIN, id: 2, domain: 'acme.io', rua_address: 'rua@reports.inboxangel.io' };
    const db = makeDb(domain2, CUSTOMER);
    const result = await resolveCustomer(db, 'acme.io');

    expect(result!.domain.domain).toBe('acme.io');
    expect(result!.customer.id).toBe('org_abc123');
  });
});
