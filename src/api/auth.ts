// Pluggable JWT auth middleware for Cloudflare Workers.
//
// Works with any OIDC-compliant provider (Auth0, Clerk, WorkOS, Cloudflare Access, etc.).
// Provider-specific config is read from env vars — swap providers by changing env, not code.
//
// Auth flow:
//   Authorization: Bearer <jwt>
//     → verify signature against JWKS
//     → extract org claim (AUTH0_ORG_CLAIM, default "org_id")
//     → return { userId }
//
// Dev/bypass mode (AUTH0_DOMAIN is empty):
//   Falls back to X-Api-Key header matched against API_KEY env var.
//   Useful for local wrangler dev and integration tests without a live IdP.

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthContext {
  userId: string;  // IdP subject or API key identity
}

// ── JWT helpers ───────────────────────────────────────────────

function base64UrlDecode(s: string): Uint8Array {
  // Base64url → standard base64 → bytes
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    s.length + (4 - (s.length % 4)) % 4, '='
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Malformed JWT');
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch {
    throw new AuthError('Could not decode JWT claims');
  }
}

// Fetches JWKS and verifies the JWT signature using Web Crypto API.
// Caches the JWKS response for the lifetime of the Worker isolate (in-memory).
let jwksCache: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
const JWKS_CACHE_TTL = 3600_000; // 1 hour

async function getJwks(jwksUri: string): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_CACHE_TTL) {
    return jwksCache.keys;
  }
  let res: Response;
  try {
    res = await fetch(jwksUri);
  } catch (e) {
    throw new AuthError(`JWKS fetch failed: ${String(e)}`);
  }
  if (!res.ok) throw new AuthError(`Failed to fetch JWKS from ${jwksUri}`);
  const { keys } = await res.json() as { keys: JsonWebKey[] };
  jwksCache = { keys, fetchedAt: now };
  return keys;
}

async function verifyJwt(token: string, jwksUri: string): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Malformed JWT');

  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
  const kid: string = header.kid;
  const alg: string = header.alg ?? 'RS256';

  const keys = await getJwks(jwksUri);
  const jwk = keys.find(k => !kid || k.kid === kid);
  if (!jwk) throw new AuthError('No matching key in JWKS');

  // Map alg string → WebCrypto params
  const cryptoAlg = alg === 'ES256'
    ? { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }; // RS256 default

  const key = await crypto.subtle.importKey('jwk', jwk, cryptoAlg, false, ['verify']);

  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlDecode(parts[2]);

  const valid = await crypto.subtle.verify(cryptoAlg, key, signature, signingInput);
  if (!valid) throw new AuthError('JWT signature invalid');

  return parseJwtClaims(token);
}

// ── Expiry + audience checks ──────────────────────────────────

function assertClaims(
  claims: Record<string, unknown>,
  audience: string,
  orgClaim: string,
): string {
  const now = Math.floor(Date.now() / 1000);

  if (typeof claims.exp === 'number' && claims.exp < now) {
    throw new AuthError('JWT expired');
  }
  if (typeof claims.nbf === 'number' && claims.nbf > now) {
    throw new AuthError('JWT not yet valid');
  }

  // Audience check — aud can be a string or array
  if (audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new AuthError('JWT audience mismatch', 403);
  }

  const orgId = claims[orgClaim];
  if (!orgId || typeof orgId !== 'string') {
    throw new AuthError(`JWT missing required claim: ${orgClaim}`, 403);
  }

  return orgId;
}

// ── Public API ────────────────────────────────────────────────

export interface AuthEnv {
  AUTH0_DOMAIN: string;       // e.g. "myapp.us.auth0.com" — empty = bypass mode
  AUTH0_AUDIENCE: string;     // e.g. "https://api.inboxangel.com"
  AUTH0_ORG_CLAIM?: string;   // claim carrying the org/tenant ID, default "org_id"
  API_KEY?: string;           // bypass mode: compare against X-Api-Key header
}

/**
 * Extracts and verifies the caller's identity from the request.
 * Returns { userId } on success; throws AuthError on failure.
 *
 * To swap auth providers: point AUTH0_DOMAIN to the new issuer's domain.
 * The JWKS URI is derived as: https://{AUTH0_DOMAIN}/.well-known/jwks.json
 * Rename AUTH0_DOMAIN to ISSUER_DOMAIN (or whatever) once you've migrated.
 */
export async function requireAuth(request: Request, env: AuthEnv): Promise<AuthContext> {
  // ── Dev/bypass mode ──────────────────────────────────────────
  if (!env.AUTH0_DOMAIN) {
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey || !env.API_KEY || apiKey !== env.API_KEY) {
      throw new AuthError('Auth not configured — provide X-Api-Key header');
    }
    // In bypass mode the API key IS the user ID (useful for seeding/testing)
    return { userId: apiKey };
  }

  // ── JWT verification ─────────────────────────────────────────
  const authHeader = request.headers.get('authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    throw new AuthError('Missing Authorization: Bearer token');
  }
  const token = authHeader.slice(7).trim();
  if (!token) throw new AuthError('Empty bearer token');

  const jwksUri = `https://${env.AUTH0_DOMAIN}/.well-known/jwks.json`;
  const claims = await verifyJwt(token, jwksUri);

  const orgClaim = env.AUTH0_ORG_CLAIM ?? 'org_id';
  const userId = assertClaims(claims, env.AUTH0_AUDIENCE, orgClaim);

  return { userId };
}
