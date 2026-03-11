import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildFirstReportBody, sendFirstReportNotification, ReportStats } from '../../src/notifications/first-report';

// ── Module mocks (only affects storeReport's import) ─────────

vi.mock('../../src/env-utils', () => ({
  reportsDomain: vi.fn(() => 'reports.acme.com'),
  fromEmail: vi.fn(() => 'noreply@reports.acme.com'),
  getAccountId: vi.fn(() => 'test-account-id'),
  getWorkersSubdomain: vi.fn(() => 'testaccount'),
}));

// ── Fixtures ──────────────────────────────────────────────────

const ADMIN = { email: 'admin@acme.com', name: 'Acme Admin' };

const STATS: ReportStats = {
  totalMessages: 150,
  passMessages: 140,
  failMessages: 10,
  sourceCount: 5,
};

function makeEnv(overrides: { admin?: typeof ADMIN | null; sendEmail?: boolean; customDomain?: string | null } = {}) {
  const admin = overrides.admin === undefined ? ADMIN : overrides.admin;
  const customDomainValue = overrides.customDomain !== undefined
    ? (overrides.customDomain ? { value: overrides.customDomain } : null)
    : { value: 'inbox.acme.com' };
  const settingsMap: Record<string, { value: string } | null> = {
    custom_domain: customDomainValue,
    workers_subdomain: null, // not cached — triggers API fallback
  };
  return {
    DB: {
      prepare: vi.fn((sql: string) => {
        let boundKey: string | undefined;
        const self = {
          bind: vi.fn((...args: any[]) => { boundKey = args[0]; return self; }),
          run: vi.fn().mockResolvedValue({ success: true }),
          first: vi.fn().mockImplementation(() => {
            if (sql.includes('settings') && boundKey) return Promise.resolve(settingsMap[boundKey] ?? null);
            if (sql.includes('users')) return Promise.resolve(admin);
            return Promise.resolve(null);
          }),
        };
        return self;
      }),
    } as unknown as D1Database,
    ...(overrides.sendEmail !== false
      ? { SEND_EMAIL: { send: vi.fn().mockResolvedValue(undefined) } as any }
      : {}),
  };
}

// ── buildFirstReportBody ──────────────────────────────────────

describe('buildFirstReportBody', () => {
  it('includes recipient name in greeting', () => {
    const body = buildFirstReportBody('Acme Admin', 'acme.com', STATS, 'https://acme.com');
    expect(body).toContain('Hi Acme Admin');
  });

  it('includes the domain name', () => {
    const body = buildFirstReportBody('Acme Admin', 'acme.com', STATS, 'https://acme.com');
    expect(body).toContain('acme.com');
    expect(body).toContain('first DMARC aggregate report');
  });

  it('includes stats in body', () => {
    const body = buildFirstReportBody('Acme Admin', 'acme.com', STATS, 'https://acme.com');
    expect(body).toContain('150 email(s) analyzed');
    expect(body).toContain('5 sending source(s) detected');
    expect(body).toContain('93% pass rate');
    expect(body).toContain('140 passed');
    expect(body).toContain('10 failed');
  });

  it('includes dashboard link', () => {
    const body = buildFirstReportBody('Acme Admin', 'acme.com', STATS, 'https://acme.com');
    expect(body).toContain('https://acme.com');
  });

  it('handles zero messages gracefully (0% pass rate)', () => {
    const zeroStats: ReportStats = { totalMessages: 0, passMessages: 0, failMessages: 0, sourceCount: 0 };
    const body = buildFirstReportBody('Admin', 'acme.com', zeroStats, 'https://acme.com');
    expect(body).toContain('0% pass rate');
  });
});

// ── sendFirstReportNotification ───────────────────────────────

describe('sendFirstReportNotification', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends email via SEND_EMAIL binding when configured', async () => {
    const env = makeEnv();
    await sendFirstReportNotification(env, 'acme.com', STATS);

    expect(env.SEND_EMAIL!.send).toHaveBeenCalledOnce();
    const call = (env.SEND_EMAIL!.send as any).mock.calls[0][0];
    expect(call.subject).toContain('First DMARC report received for acme.com');
    expect(call.to).toEqual(['admin@acme.com']);
    expect(call.text).toContain('150 email(s) analyzed');
    expect(call.text).toContain('https://inbox.acme.com');
  });

  it('uses custom_domain for dashboard URL', async () => {
    const env = makeEnv({ customDomain: 'mail.example.org' });
    await sendFirstReportNotification(env, 'example.org', STATS);

    const call = (env.SEND_EMAIL!.send as any).mock.calls[0][0];
    expect(call.text).toContain('https://mail.example.org');
  });

  it('falls back to workers.dev with subdomain when no custom_domain', async () => {
    const env = makeEnv({ customDomain: null });
    await sendFirstReportNotification(env, 'acme.com', STATS);

    const call = (env.SEND_EMAIL!.send as any).mock.calls[0][0];
    expect(call.text).toContain('https://inbox-angel-worker.testaccount.workers.dev');
  });

  it('logs instead of sending when SEND_EMAIL binding is absent', async () => {
    const env = makeEnv({ sendEmail: false });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendFirstReportNotification(env, 'acme.com', STATS);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('would send to admin@acme.com'),
    );
    consoleSpy.mockRestore();
  });

  it('does not throw when SEND_EMAIL binding is absent', async () => {
    const env = makeEnv({ sendEmail: false });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(sendFirstReportNotification(env, 'acme.com', STATS)).resolves.not.toThrow();

    vi.restoreAllMocks();
  });

  it('skips when no admin user exists', async () => {
    const env = makeEnv({ admin: null });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendFirstReportNotification(env, 'acme.com', STATS);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('no admin user found'),
    );
    consoleSpy.mockRestore();
  });

  it('uses fallback name "there" when admin has no name', async () => {
    const env = makeEnv({ admin: { email: 'admin@acme.com', name: null as any } });
    await sendFirstReportNotification(env, 'acme.com', STATS);

    const call = (env.SEND_EMAIL!.send as any).mock.calls[0][0];
    expect(call.text).toContain('Hi there');
  });
});

// ── First-report trigger in storeReport ───────────────────────

describe('storeReport first-report trigger', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeReport() {
    return {
      xml_schema: 'draft' as const,
      report_metadata: {
        org_name: 'google.com',
        org_email: 'noreply@google.com',
        org_extra_contact_info: null,
        report_id: 'report-001',
        begin_date: '2024-06-13T00:00:00Z',
        end_date: '2024-06-13T23:59:59Z',
        errors: [],
      },
      policy_published: {
        domain: 'acme.com',
        adkim: 'r' as const,
        aspf: 'r' as const,
        p: 'reject' as const,
        sp: 'reject' as const,
        pct: 100,
        fo: '0',
      },
      records: [{
        source: { ip: '1.2.3.4', reverse_dns: null, base_domain: null, country_code: null, country_name: null, subdivision: null, city: null },
        count: 10,
        alignment: { spf: true, dkim: true, dmarc: true },
        policy_evaluated: { disposition: 'none' as const, dkim: 'pass' as const, spf: 'pass' as const, policy_override_reasons: [] },
        identifiers: { header_from: 'acme.com', envelope_from: null, envelope_to: null },
        auth_results: {
          dkim: [{ domain: 'acme.com', selector: 'sel', result: 'pass' as const }],
          spf: [{ domain: 'acme.com', scope: 'mfrom', result: 'pass' as const }],
        },
      }],
    };
  }

  function makeMockDb(opts: { lastRowId?: number; reportCount?: number } = {}) {
    const { lastRowId = 42, reportCount = 1 } = opts;
    return {
      prepare: vi.fn((sql: string) => {
        let boundKey: string | undefined;
        const self = {
          bind: vi.fn((...args: any[]) => { boundKey = args[0]; return self; }),
          run: vi.fn().mockResolvedValue({ meta: { last_row_id: lastRowId }, success: true }),
          first: vi.fn().mockImplementation(() => {
            if (sql.includes('COUNT(*)')) return Promise.resolve({ cnt: reportCount });
            if (sql.includes('SELECT domain')) return Promise.resolve({ domain: 'acme.com' });
            if (sql.includes('users')) return Promise.resolve({ email: 'admin@acme.com', name: 'Admin' });
            if (sql.includes('settings')) return Promise.resolve(null); // no custom_domain or cached subdomain
            return Promise.resolve(null);
          }),
        };
        return self;
      }),
      batch: vi.fn((stmts: any[]) => Promise.resolve(stmts.map(() => ({ success: true, meta: {} })))),
    } as unknown as D1Database;
  }

  it('fires notification on first report (count=1)', async () => {
    const { storeReport } = await import('../../src/dmarc/store-report');

    const db = makeMockDb({ reportCount: 1 });
    const sendEmail = { send: vi.fn().mockResolvedValue(undefined) };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await storeReport(db, 1, makeReport(), null, { DB: db, SEND_EMAIL: sendEmail });

    // fire-and-forget — wait for microtask queue to flush
    await new Promise(r => setTimeout(r, 50));

    expect(sendEmail.send).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it('does NOT fire notification on subsequent reports (count>1)', async () => {
    const { storeReport } = await import('../../src/dmarc/store-report');

    const db = makeMockDb({ reportCount: 5 });
    const sendEmail = { send: vi.fn().mockResolvedValue(undefined) };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await storeReport(db, 1, makeReport(), null, { DB: db, SEND_EMAIL: sendEmail });

    await new Promise(r => setTimeout(r, 10));

    expect(sendEmail.send).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does NOT fire notification on duplicate reports (stored=false)', async () => {
    const { storeReport } = await import('../../src/dmarc/store-report');

    const db = makeMockDb({ lastRowId: 0 }); // 0 = duplicate
    const sendEmail = { send: vi.fn().mockResolvedValue(undefined) };

    await storeReport(db, 1, makeReport(), null, { DB: db, SEND_EMAIL: sendEmail });

    await new Promise(r => setTimeout(r, 10));

    expect(sendEmail.send).not.toHaveBeenCalled();
  });

  it('does NOT fire notification when env is not provided', async () => {
    const { storeReport } = await import('../../src/dmarc/store-report');

    const db = makeMockDb({ reportCount: 1 });
    const sendEmail = { send: vi.fn().mockResolvedValue(undefined) };

    await storeReport(db, 1, makeReport());

    await new Promise(r => setTimeout(r, 10));

    expect(sendEmail.send).not.toHaveBeenCalled();
  });
});
