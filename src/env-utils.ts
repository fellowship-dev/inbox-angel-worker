import { Env } from './index';

export function reportsDomain(env: Pick<Env, 'REPORTS_DOMAIN' | 'BASE_DOMAIN'>): string | undefined {
  return env.REPORTS_DOMAIN ?? (env.BASE_DOMAIN ? `reports.${env.BASE_DOMAIN}` : undefined);
}

export function fromEmail(env: Pick<Env, 'FROM_EMAIL' | 'BASE_DOMAIN'>): string | undefined {
  return env.FROM_EMAIL ?? (env.BASE_DOMAIN ? `noreply@reports.${env.BASE_DOMAIN}` : undefined);
}

// Module-level cache — lives for the lifetime of the Worker instance (reused across requests)
let _zoneIdCache: string | undefined;
let _accountIdCache: string | undefined;

/**
 * Return the cached zone ID (set by resolveZoneId / enrichEnv).
 * Returns undefined if the cache has not been warmed yet.
 */
export function getZoneId(): string | undefined {
  return _zoneIdCache;
}

/**
 * Return the cached account ID (set by resolveZoneId / enrichEnv).
 * Auto-derived from the zones API response — no extra secret needed.
 */
export function getAccountId(): string | undefined {
  return _accountIdCache;
}

/**
 * Resolve the Cloudflare zone ID via CF API using BASE_DOMAIN.
 * Also caches account ID from the same response — no extra API call.
 * Result is cached in-process — only one API call per cold start.
 */
export async function resolveZoneId(
  env: Pick<Env, 'CLOUDFLARE_API_TOKEN' | 'BASE_DOMAIN'>
): Promise<string | undefined> {
  if (_zoneIdCache) return _zoneIdCache;
  if (!env.CLOUDFLARE_API_TOKEN || !env.BASE_DOMAIN) return undefined;

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(env.BASE_DOMAIN)}`,
      { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }
    );
    const data = await res.json() as { result?: { id: string; account: { id: string } }[] };
    _zoneIdCache = data.result?.[0]?.id;
    _accountIdCache = data.result?.[0]?.account?.id;
    return _zoneIdCache;
  } catch {
    return undefined;
  }
}

/**
 * Warm the zone ID cache. Call once at the top of request/cron handlers.
 * Uses CLOUDFLARE_ZONE_ID / CLOUDFLARE_ACCOUNT_ID env vars if set,
 * otherwise resolves via API. Zone ID is then accessed via getZoneId().
 */
export async function enrichEnv(env: Env): Promise<Env> {
  if ((env as Record<string, unknown>).CLOUDFLARE_ZONE_ID && !_zoneIdCache) {
    _zoneIdCache = (env as Record<string, unknown>).CLOUDFLARE_ZONE_ID as string;
  }
  if ((env as Record<string, unknown>).CLOUDFLARE_ACCOUNT_ID && !_accountIdCache) {
    _accountIdCache = (env as Record<string, unknown>).CLOUDFLARE_ACCOUNT_ID as string;
  }
  // Always call resolveZoneId if either cache is missing — it populates both from one API call
  if (!_zoneIdCache || !_accountIdCache) await resolveZoneId(env);
  return env;
}
