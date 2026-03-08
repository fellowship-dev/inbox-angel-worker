// Integration-style tests for handleFreeCheck.
// All I/O (fetch, D1, message.reply) is mocked — no network required.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleFreeCheck } from '../../src/email/free-check';
import type { Env } from '../../src/index';

// ── Helpers ───────────────────────────────────────────────────

function makeEnv(overrides: Partial<Env> = {}): Env {
  const db = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }),
  } as unknown as D1Database;

  return {
    DB: db,
    AUTH0_DOMAIN: '',
    AUTH0_AUDIENCE: '',
    CLOUDFLARE_ACCOUNT_ID: '',
    CLOUDFLARE_ZONE_ID: '',
    CLOUDFLARE_API_TOKEN: '',
    FROM_EMAIL: 'check@reports.inboxangel.com',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<{
  from: string;
  to: string;
  authResults: string;
}>= {}): ForwardableEmailMessage {
  const authHeader = overrides.authResults ?? [
    'mx.google.com;',
    ' dkim=pass header.d=example.com header.s=selector1;',
    ' spf=pass smtp.mailfrom=user@example.com;',
    ' dmarc=pass (p=reject dis=none) header.from=example.com',
  ].join('');

  const headers = new Headers({ 'authentication-results': authHeader });

  return {
    from: overrides.from ?? 'user@example.com',
    to: overrides.to ?? 'check@reports.inboxangel.com',
    headers,
    reply: vi.fn().mockResolvedValue(undefined),
    forward: vi.fn(),
    setReject: vi.fn(),
  } as unknown as ForwardableEmailMessage;
}

// Mock DoH responses for SPF/DMARC/DKIM
function mockDohAll() {
  vi.mocked(fetch)
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        Answer: [{ type: 16, data: '"v=spf1 include:_spf.google.com -all"' }],
      }),
    } as unknown as Response)  // SPF
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        Answer: [{ type: 16, data: '"v=DMARC1; p=reject; pct=100"' }],
      }),
    } as unknown as Response)  // DMARC
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        Answer: [{ type: 16, data: '"v=DKIM1; k=rsa; p=ABC"' }],
      }),
    } as unknown as Response); // DKIM
}

function mockDohEmpty() {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ Answer: [] }),
  } as unknown as Response);
}

// ── Tests ─────────────────────────────────────────────────────

describe('handleFreeCheck', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('calls message.reply with a MIME stream', async () => {
    mockDohAll();
    const message = makeMessage();
    const env = makeEnv();

    await handleFreeCheck(message, env);

    expect(message.reply).toHaveBeenCalledOnce();
    const arg = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toBeInstanceOf(ReadableStream);
  });

  it('MIME reply contains domain name', async () => {
    mockDohAll();
    const message = makeMessage({ from: 'founder@startupxyz.com' });
    const env = makeEnv();

    await handleFreeCheck(message, env);

    const stream = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReadableStream;
    const reader = stream.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('startupxyz.com');
  });

  it('MIME reply contains From and Subject headers', async () => {
    mockDohAll();
    const message = makeMessage();
    const env = makeEnv();

    await handleFreeCheck(message, env);

    const stream = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReadableStream;
    const reader = stream.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('From:');
    expect(text).toContain('Subject:');
    expect(text).toContain('check@reports.inboxangel.com');
  });

  it('stores result in D1', async () => {
    mockDohAll();
    const message = makeMessage();
    const env = makeEnv();

    await handleFreeCheck(message, env);

    expect(env.DB.prepare).toHaveBeenCalled();
  });

  it('extracts domain from from address correctly', async () => {
    mockDohAll();
    const message = makeMessage({ from: 'hello@my-company.io' });
    const env = makeEnv();

    await handleFreeCheck(message, env);

    const stream = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReadableStream;
    const reader = stream.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('my-company.io');
  });

  it('still sends reply even when all DNS lookups return nothing', async () => {
    mockDohEmpty();
    const message = makeMessage();
    const env = makeEnv();

    await handleFreeCheck(message, env);

    expect(message.reply).toHaveBeenCalledOnce();
  });

  it('report says "exposed" when DNS is empty', async () => {
    mockDohEmpty();
    const message = makeMessage({
      authResults: 'mx.example.com; spf=fail smtp.mailfrom=user@example.com',
    });
    const env = makeEnv();

    await handleFreeCheck(message, env);

    const stream = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReadableStream;
    const reader = stream.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('🚨'); // exposed status line
  });

  it('handles missing Authentication-Results header gracefully', async () => {
    mockDohEmpty();
    const message: ForwardableEmailMessage = {
      from: 'user@nodomain.com',
      to: 'check@reports.inboxangel.com',
      headers: new Headers(), // no auth-results
      reply: vi.fn().mockResolvedValue(undefined),
      forward: vi.fn(),
      setReject: vi.fn(),
    } as unknown as ForwardableEmailMessage;

    const env = makeEnv();
    await handleFreeCheck(message, env);

    expect(message.reply).toHaveBeenCalledOnce();
  });

  it('does not throw when D1 insert fails', async () => {
    mockDohAll();
    const message = makeMessage();
    const brokenDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
        }),
      }),
    } as unknown as D1Database;

    const env = makeEnv({ DB: brokenDb });
    // Should not throw — DB failure is swallowed with console.error
    await expect(handleFreeCheck(message, env)).resolves.toBeUndefined();
    expect(message.reply).toHaveBeenCalledOnce();
  });
});
