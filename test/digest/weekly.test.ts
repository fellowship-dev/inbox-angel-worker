import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDigestBody, sendWeeklyDigests } from '../../src/digest/weekly';
import type { DomainWeeklyStat, FailingSource } from '../../src/db/queries';

// ── Module mocks ──────────────────────────────────────────────

vi.mock('../../src/db/queries', () => ({
  getAllCustomers: vi.fn(),
  getWeeklyDomainStats: vi.fn(),
  getTopFailingSources: vi.fn(),
}));

import * as queries from '../../src/db/queries';

// ── Fixtures ──────────────────────────────────────────────────

const CUSTOMER = { id: 'org_1', name: 'Acme', email: 'admin@acme.com', plan: 'starter', created_at: 0, updated_at: 0 };

const STAT_GOOD: DomainWeeklyStat = {
  domain_id: 1, domain: 'acme.com', dmarc_policy: 'reject',
  total_messages: 1000, pass_messages: 980, fail_messages: 20, report_count: 5,
};

const STAT_CLEAN: DomainWeeklyStat = {
  domain_id: 2, domain: 'acme.io', dmarc_policy: 'reject',
  total_messages: 200, pass_messages: 200, fail_messages: 0, report_count: 2,
};

const STAT_NONE: DomainWeeklyStat = {
  domain_id: 3, domain: 'acme.net', dmarc_policy: 'none',
  total_messages: 50, pass_messages: 30, fail_messages: 20, report_count: 1,
};

const STAT_NO_REPORTS: DomainWeeklyStat = {
  domain_id: 4, domain: 'acme.org', dmarc_policy: null,
  total_messages: 0, pass_messages: 0, fail_messages: 0, report_count: 0,
};

const SOURCE: FailingSource = { source_ip: '1.2.3.4', total: 20, header_from: 'mail.acme.com' };

function makeEnv() {
  return {
    DB: {} as D1Database,
    FROM_EMAIL: 'noreply@reports.inboxangel.io',
    REPORTS_DOMAIN: 'reports.inboxangel.io',
  };
}

// ── buildDigestBody ───────────────────────────────────────────

describe('buildDigestBody', () => {
  it('includes customer name in greeting', () => {
    const body = buildDigestBody('Acme', [STAT_GOOD], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('Hi Acme');
  });

  it('includes domain name and policy', () => {
    const body = buildDigestBody('Acme', [STAT_GOOD], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('Domain: acme.com');
    expect(body).toContain('reject ✅');
  });

  it('shows message counts and pass percentage', () => {
    const body = buildDigestBody('Acme', [STAT_GOOD], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('1,000');
    expect(body).toContain('98%');
  });

  it('shows top failing sources when present', () => {
    const sources = new Map([[1, [SOURCE]]]);
    const body = buildDigestBody('Acme', [STAT_GOOD], sources, 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('1.2.3.4');
    expect(body).toContain('mail.acme.com');
  });

  it('shows rua hint for domains with no reports', () => {
    const body = buildDigestBody('Acme', [STAT_NO_REPORTS], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('No reports received');
    expect(body).toContain('rua=mailto:rua@reports.inboxangel.io');
  });

  it('includes CTA for domains with weak policy', () => {
    const body = buildDigestBody('Acme', [STAT_NONE], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('not enforcing DMARC');
    expect(body).toContain('inboxangel.io');
  });

  it('no CTA when all domains have reject policy', () => {
    const body = buildDigestBody('Acme', [STAT_CLEAN], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).not.toContain('not enforcing DMARC');
  });

  it('handles multiple domains', () => {
    const body = buildDigestBody('Acme', [STAT_GOOD, STAT_CLEAN], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('acme.com');
    expect(body).toContain('acme.io');
  });
});

// ── sendWeeklyDigests ─────────────────────────────────────────

describe('sendWeeklyDigests', () => {
  beforeEach(() => {
    vi.mocked(queries.getAllCustomers).mockResolvedValue({ results: [CUSTOMER] } as any);
    vi.mocked(queries.getWeeklyDomainStats).mockResolvedValue({ results: [STAT_GOOD] } as any);
    vi.mocked(queries.getTopFailingSources).mockResolvedValue({ results: [SOURCE] } as any);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls getWeeklyDomainStats for each customer', async () => {
    await sendWeeklyDigests(makeEnv());
    expect(queries.getWeeklyDomainStats).toHaveBeenCalledWith(makeEnv().DB, 'org_1', expect.any(Number));
  });

  it('fetches failing sources only for domains with failures', async () => {
    await sendWeeklyDigests(makeEnv());
    expect(queries.getTopFailingSources).toHaveBeenCalledWith(makeEnv().DB, 1, expect.any(Number));
  });

  it('skips getTopFailingSources when domain has no failures', async () => {
    vi.mocked(queries.getWeeklyDomainStats).mockResolvedValue({ results: [STAT_CLEAN] } as any);
    await sendWeeklyDigests(makeEnv());
    expect(queries.getTopFailingSources).not.toHaveBeenCalled();
  });

  it('sends email via Resend when API key is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendWeeklyDigests({ ...makeEnv(), RESEND_API_KEY: 're_test' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('logs instead of sending when RESEND_API_KEY is absent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendWeeklyDigests(makeEnv()); // no RESEND_API_KEY
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('would send to admin@acme.com'));
    consoleSpy.mockRestore();
  });

  it('skips customers with no domains', async () => {
    vi.mocked(queries.getWeeklyDomainStats).mockResolvedValue({ results: [] } as any);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await sendWeeklyDigests(makeEnv());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('continues to next customer when one fails', async () => {
    const customer2 = { ...CUSTOMER, id: 'org_2', email: 'admin@other.com' };
    vi.mocked(queries.getAllCustomers).mockResolvedValue({ results: [CUSTOMER, customer2] } as any);
    vi.mocked(queries.getWeeklyDomainStats)
      .mockRejectedValueOnce(new Error('D1 timeout'))
      .mockResolvedValueOnce({ results: [STAT_GOOD] } as any);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await sendWeeklyDigests(makeEnv());
    // Second customer was still processed (log called for it)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('sent to admin@other.com'));
    consoleSpy.mockRestore();
  });
});
