import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkSubscription } from '../../src/monitor/check';
import type { MonitorSubscription } from '../../src/db/types';

function makeSub(overrides: Partial<MonitorSubscription> = {}): MonitorSubscription {
  return {
    id: 1,
    email: 'test@example.com',
    domain: 'acme.com',
    session_token: 'tok',
    spf_record: 'v=spf1 include:_spf.google.com -all',
    dmarc_policy: 'none',
    dmarc_pct: 100,
    dmarc_record: 'v=DMARC1; p=none; pct=100',
    active: 1,
    last_checked_at: null,
    created_at: 0,
    ...overrides,
  };
}

function mockDns(spfRaw: string | null, dmarcRaw: string | null) {
  vi.mocked(fetch).mockImplementation(async (url) => {
    const u = url.toString();
    if (u.includes('_dmarc.')) {
      return new Response(JSON.stringify({
        Answer: dmarcRaw ? [{ type: 16, data: `"${dmarcRaw}"` }] : [],
      }), { status: 200 });
    }
    // SPF
    return new Response(JSON.stringify({
      Answer: spfRaw ? [{ type: 16, data: `"${spfRaw}"` }] : [],
    }), { status: 200 });
  });
}

describe('checkSubscription', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it('returns no changes when DNS matches baseline', async () => {
    mockDns('v=spf1 include:_spf.google.com -all', 'v=DMARC1; p=none; pct=100');
    const result = await checkSubscription(makeSub());
    expect(result.changes).toHaveLength(0);
  });

  it('detects SPF record change', async () => {
    mockDns('v=spf1 include:sendgrid.net -all', 'v=DMARC1; p=none; pct=100');
    const result = await checkSubscription(makeSub());
    const spfChange = result.changes.find(c => c.field === 'SPF record');
    expect(spfChange).toBeDefined();
    expect(spfChange!.was).toContain('google.com');
    expect(spfChange!.now).toContain('sendgrid.net');
  });

  it('detects DMARC policy upgrade as improved', async () => {
    mockDns('v=spf1 -all', 'v=DMARC1; p=reject; pct=100');
    const result = await checkSubscription(makeSub({ dmarc_policy: 'none' }));
    const change = result.changes.find(c => c.field === 'DMARC policy');
    expect(change).toBeDefined();
    expect(change!.severity).toBe('improved');
    expect(change!.now).toBe('reject');
  });

  it('detects DMARC policy downgrade as degraded', async () => {
    mockDns('v=spf1 -all', 'v=DMARC1; p=none; pct=100');
    const result = await checkSubscription(makeSub({ dmarc_policy: 'reject' }));
    const change = result.changes.find(c => c.field === 'DMARC policy');
    expect(change!.severity).toBe('degraded');
  });

  it('detects DMARC pct decrease as degraded', async () => {
    mockDns('v=spf1 -all', 'v=DMARC1; p=reject; pct=50');
    const result = await checkSubscription(makeSub({ dmarc_policy: 'reject', dmarc_pct: 100 }));
    const change = result.changes.find(c => c.field === 'DMARC enforcement %');
    expect(change!.severity).toBe('degraded');
    expect(change!.was).toBe('100%');
    expect(change!.now).toBe('50%');
  });

  it('does not report pct change when policy is none', async () => {
    mockDns('v=spf1 -all', 'v=DMARC1; p=none; pct=50');
    const result = await checkSubscription(makeSub({ dmarc_policy: 'none', dmarc_pct: 100 }));
    expect(result.changes.find(c => c.field === 'DMARC enforcement %')).toBeUndefined();
  });

  it('detects SPF removal as degraded', async () => {
    mockDns(null, 'v=DMARC1; p=none');
    const result = await checkSubscription(makeSub());
    const change = result.changes.find(c => c.field === 'SPF record');
    expect(change!.severity).toBe('degraded');
    expect(change!.now).toBe('');
  });

  it('returns newBaseline reflecting current DNS', async () => {
    mockDns('v=spf1 include:new.com -all', 'v=DMARC1; p=quarantine; pct=80');
    const result = await checkSubscription(makeSub());
    expect(result.newBaseline.spf_record).toContain('new.com');
    expect(result.newBaseline.dmarc_policy).toBe('quarantine');
    expect(result.newBaseline.dmarc_pct).toBe(80);
  });

  it('handles null baselines gracefully (first check)', async () => {
    mockDns('v=spf1 -all', 'v=DMARC1; p=reject');
    const result = await checkSubscription(makeSub({ spf_record: null, dmarc_policy: null, dmarc_record: null }));
    // SPF appeared = improved
    const spfChange = result.changes.find(c => c.field === 'SPF record');
    expect(spfChange!.severity).toBe('improved');
  });
});
