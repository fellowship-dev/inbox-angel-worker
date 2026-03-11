import { Env } from './index';
import { getSettings, persistConfig } from './db/queries';

// Module-level cache — lives for the lifetime of the Worker instance (reused across requests)
let _zoneIdCache: string | undefined;
let _accountIdCache: string | undefined;
let _baseDomainCache: string | undefined;
let _reportsDomainCache: string | undefined;
let _fromEmailCache: string | undefined;

export function reportsDomain(env: Pick<Env, 'REPORTS_DOMAIN' | 'BASE_DOMAIN'>): string | undefined {
  if (_reportsDomainCache) return _reportsDomainCache;
  return env.REPORTS_DOMAIN ?? (env.BASE_DOMAIN ? `reports.${env.BASE_DOMAIN}` : undefined);
}

export function fromEmail(env: Pick<Env, 'FROM_EMAIL' | 'BASE_DOMAIN'>): string | undefined {
  if (_fromEmailCache) return _fromEmailCache;
  return env.FROM_EMAIL ?? (env.BASE_DOMAIN ? `noreply@reports.${env.BASE_DOMAIN}` : undefined);
}

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
 * Return the cached base domain (set by enrichEnv from env var or D1).
 */
export function getBaseDomain(): string | undefined {
  return _baseDomainCache;
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
  const baseDomain = _baseDomainCache ?? env.BASE_DOMAIN;
  if (!env.CLOUDFLARE_API_TOKEN || !baseDomain) return undefined;

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(baseDomain)}`,
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
 * Warm all caches. Call once at the top of request/cron handlers.
 *
 * Resolution order per setting:
 *   1. Module-level cache (hot path — no I/O)
 *   2. Environment variable (wrangler.jsonc vars or secrets)
 *   3. D1 settings table (persisted by wizard)
 *   4. Cloudflare API (zone_id + account_id only)
 *   5. Derived defaults (reports_domain, from_email)
 *
 * After resolution, zone_id and account_id are persisted to D1 so subsequent
 * cold starts skip the API call.
 */
export async function enrichEnv(env: Env, db?: D1Database): Promise<Env> {
  const effectiveDb = db ?? env.DB;

  // 1. Load from D1 if we have a database and any cache is empty
  if (effectiveDb && (!_baseDomainCache || !_zoneIdCache || !_accountIdCache || !_reportsDomainCache || !_fromEmailCache)) {
    const settings = await getSettings(effectiveDb, [
      'base_domain', 'zone_id', 'account_id', 'reports_domain', 'from_email',
    ]);

    if (!_baseDomainCache) _baseDomainCache = env.BASE_DOMAIN ?? settings.get('base_domain');
    if (!_zoneIdCache) _zoneIdCache = settings.get('zone_id');
    if (!_accountIdCache) _accountIdCache = settings.get('account_id');
    if (!_reportsDomainCache) _reportsDomainCache = env.REPORTS_DOMAIN ?? settings.get('reports_domain');
    if (!_fromEmailCache) _fromEmailCache = env.FROM_EMAIL ?? settings.get('from_email');
  } else {
    // No DB — fall back to env vars only
    if (!_baseDomainCache) _baseDomainCache = env.BASE_DOMAIN;
  }

  // 2. Resolve zone_id + account_id via API if still missing
  if ((!_zoneIdCache || !_accountIdCache) && _baseDomainCache && env.CLOUDFLARE_API_TOKEN) {
    await resolveZoneId({ ...env, BASE_DOMAIN: _baseDomainCache });
  }

  // 3. Derive defaults
  if (!_reportsDomainCache && _baseDomainCache) {
    _reportsDomainCache = `reports.${_baseDomainCache}`;
  }
  if (!_fromEmailCache && _baseDomainCache) {
    _fromEmailCache = `noreply@reports.${_baseDomainCache}`;
  }

  // 4. Persist resolved values to D1 (fire-and-forget, non-blocking)
  if (effectiveDb && _zoneIdCache && _accountIdCache && _baseDomainCache) {
    const toStore: Record<string, string> = {};
    // Only persist values that came from API resolution, not from D1
    if (_zoneIdCache) toStore.zone_id = _zoneIdCache;
    if (_accountIdCache) toStore.account_id = _accountIdCache;
    if (Object.keys(toStore).length > 0) {
      persistConfig(effectiveDb, toStore).catch(() => {});
    }
  }

  return env;
}

/**
 * Reset module-level caches. Useful after a new base_domain is set via the wizard.
 */
export function resetEnvCache(): void {
  _zoneIdCache = undefined;
  _accountIdCache = undefined;
  _baseDomainCache = undefined;
  _reportsDomainCache = undefined;
  _fromEmailCache = undefined;
}
