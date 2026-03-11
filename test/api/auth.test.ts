import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requireAuth, AuthError } from '../../src/api/auth';
import type { AuthEnv } from '../../src/api/auth';

// ── Bypass mode (AUTH0_DOMAIN empty) ─────────────────────────

const BYPASS_ENV: AuthEnv = {
  AUTH0_DOMAIN: '',
  AUTH0_AUDIENCE: '',
  API_KEY: 'test-key-org_abc123',
};

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://api.inboxangel.com/api/domains', { headers });
}

describe('requireAuth — bypass mode (AUTH0_DOMAIN empty)', () => {
  it('returns userId = api key value when key matches', async () => {
    const req = makeRequest({ 'x-api-key': 'test-key-org_abc123' });
    const ctx = await requireAuth(req, BYPASS_ENV);
    expect(ctx.userId).toBe('test-key-org_abc123');
  });

  it('throws AuthError when x-api-key is missing', async () => {
    const req = makeRequest();
    await expect(requireAuth(req, BYPASS_ENV)).rejects.toThrow(AuthError);
  });

  it('throws AuthError when x-api-key does not match', async () => {
    const req = makeRequest({ 'x-api-key': 'wrong-key' });
    await expect(requireAuth(req, BYPASS_ENV)).rejects.toThrow(AuthError);
  });

  it('throws AuthError when API_KEY is not configured in env', async () => {
    const env: AuthEnv = { AUTH0_DOMAIN: '', AUTH0_AUDIENCE: '' }; // no API_KEY
    const req = makeRequest({ 'x-api-key': 'any-key' });
    await expect(requireAuth(req, env)).rejects.toThrow(AuthError);
  });

  it('AuthError has status 401', async () => {
    const req = makeRequest();
    try {
      await requireAuth(req, BYPASS_ENV);
    } catch (e) {
      expect((e as AuthError).status).toBe(401);
    }
  });
});

// ── JWT mode (AUTH0_DOMAIN set) ───────────────────────────────
// We test the rejection paths without a real IdP.
// Full JWT verification is an integration concern (needs real JWKS).

describe('requireAuth — JWT mode (AUTH0_DOMAIN set)', () => {
  const JWT_ENV: AuthEnv = {
    AUTH0_DOMAIN: 'myapp.us.auth0.com',
    AUTH0_AUDIENCE: 'https://api.inboxangel.com',
  };

  it('throws AuthError when Authorization header is missing', async () => {
    const req = makeRequest();
    await expect(requireAuth(req, JWT_ENV)).rejects.toThrow(AuthError);
    await expect(requireAuth(req, JWT_ENV)).rejects.toThrow('Missing Authorization');
  });

  it('throws AuthError when Authorization is not Bearer', async () => {
    const req = makeRequest({ authorization: 'Basic dXNlcjpwYXNz' });
    await expect(requireAuth(req, JWT_ENV)).rejects.toThrow(AuthError);
  });

  it('throws AuthError for empty bearer token', async () => {
    const req = makeRequest({ authorization: 'Bearer ' });
    await expect(requireAuth(req, JWT_ENV)).rejects.toThrow(AuthError);
  });

  it('throws AuthError for malformed JWT (not 3 parts)', async () => {
    const req = makeRequest({ authorization: 'Bearer onlytwoparts.here' });
    // Will fail at verifyJwt (JWKS fetch or malformed check)
    await expect(requireAuth(req, JWT_ENV)).rejects.toThrow(AuthError);
  });

  it('throws AuthError when JWKS fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    // Use a structurally valid JWT (3 parts) to get past the parse check
    const fakeJwt = 'eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ1c2VyMSJ9.c2lnbmF0dXJl';
    const req = makeRequest({ authorization: `Bearer ${fakeJwt}` });
    await expect(requireAuth(req, JWT_ENV)).rejects.toThrow(AuthError);
    vi.unstubAllGlobals();
  });

  it('throws AuthError when JWKS endpoint returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response));
    const fakeJwt = 'eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ1c2VyMSJ9.c2lnbmF0dXJl';
    const req = makeRequest({ authorization: `Bearer ${fakeJwt}` });
    await expect(requireAuth(req, JWT_ENV)).rejects.toThrow(AuthError);
    vi.unstubAllGlobals();
  });
});

// ── AuthError class ───────────────────────────────────────────

describe('AuthError', () => {
  it('has name AuthError', () => {
    expect(new AuthError('msg').name).toBe('AuthError');
  });

  it('defaults to status 401', () => {
    expect(new AuthError('msg').status).toBe(401);
  });

  it('accepts status 403', () => {
    expect(new AuthError('msg', 403).status).toBe(403);
  });
});
