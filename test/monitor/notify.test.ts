import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendChangeNotification } from '../../src/monitor/notify';
import type { DomainChange } from '../../src/monitor/check';

const ENV = {
  RESEND_API_KEY: 'resend-test-key',
  FROM_EMAIL: 'check@reports.inboxangel.io',
  REPORTS_DOMAIN: 'reports.inboxangel.io',
};

const degraded: DomainChange = { field: 'DMARC policy', was: 'reject', now: 'none', severity: 'degraded' };
const improved: DomainChange = { field: 'DMARC policy', was: 'none', now: 'reject', severity: 'improved' };

beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))));
afterEach(() => vi.unstubAllGlobals());

describe('sendChangeNotification', () => {
  it('POSTs to Resend API when key is set', async () => {
    await sendChangeNotification('user@example.com', 'acme.com', [improved], ENV);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sends Authorization header with Bearer token', async () => {
    await sendChangeNotification('user@example.com', 'acme.com', [improved], ENV);
    const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer resend-test-key');
  });

  it('uses degraded subject line when change is degraded', async () => {
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], ENV);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.subject).toContain('degraded');
  });

  it('uses neutral subject line when all changes are improved', async () => {
    await sendChangeNotification('user@example.com', 'acme.com', [improved], ENV);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.subject).not.toContain('degraded');
  });

  it('includes domain name in email body', async () => {
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], ENV);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.text).toContain('acme.com');
  });

  it('includes fix CTA when changes are degraded', async () => {
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], ENV);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.text).toContain('inboxangel.io');
  });

  it('does not call fetch when RESEND_API_KEY is not set', async () => {
    const env = { ...ENV, RESEND_API_KEY: undefined };
    await sendChangeNotification('user@example.com', 'acme.com', [improved], env);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('does not throw when Resend returns error status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    await expect(
      sendChangeNotification('user@example.com', 'acme.com', [degraded], ENV)
    ).resolves.toBeUndefined();
  });
});
