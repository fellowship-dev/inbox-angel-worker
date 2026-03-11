import { Env } from './index';
import { getSettings, persistConfig } from './db/queries';

// Module-level cache — lives for the lifetime of the Worker instance (reused across requests)
let _zoneIdCache: string | undefined;
let _accountIdCache: string | undefined;
let _baseDomainCache: string | undefined;
let _reportsDomainCache: string | undefined;
let _fromEmailCache: string | undefined;
let _workersSubdomainCache: string | undefined;

/** Return the cached reports domain (e.g. "reports.yourdomain.com"). */
export function reportsDomain(): string | undefined {
  return _reportsDomainCache;
}

/** Return the cached from email (e.g. "noreply@reports.yourdomain.com"). */
export function fromEmail(): string | undefined {
  return _fromEmailCache;
}

/** Return the cached zone ID (set by resolveZoneId / enrichEnv). */
export function getZoneId(): string | undefined {
  return _zoneIdCache;
}

/** Return the cached account ID (set by resolveZoneId / enrichEnv). */
export function getAccountId(): string | undefined {
  return _accountIdCache;
}

/** Return the cached base domain (set by enrichEnv from D1). */
export function getBaseDomain(): string | undefined {
  return _baseDomainCache;
}

/** Return the cached workers subdomain (e.g. "fellowshipdev"). */
export function getWorkersSubdomain(): string | undefined {
  return _workersSubdomainCache;
}

/**
 * Resolve the Cloudflare zone ID via CF API.
 * Also caches account ID from the same response.
 * Result is cached in-process — only one API call per cold start.
 */
async function resolveZoneId(apiToken: string): Promise<string | undefined> {
  if (_zoneIdCache) return _zoneIdCache;
  if (!_baseDomainCache) return undefined;

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(_baseDomainCache)}`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
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
 * Resolve the Cloudflare Workers subdomain via CF API.
 * GET /accounts/{account_id}/workers/subdomain → { subdomain: "fellowshipdev" }
 * Result is cached in-process + D1.
 */
async function resolveWorkersSubdomain(apiToken: string): Promise<string | undefined> {
  if (_workersSubdomainCache) return _workersSubdomainCache;
  if (!_accountIdCache) return undefined;

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${_accountIdCache}/workers/subdomain`,
      { headers: { Authorization: `Bearer ${apiToken}` } },
    );
    if (!res.ok) return undefined;
    const data = await res.json() as { result?: { subdomain: string } };
    _workersSubdomainCache = data.result?.subdomain;
    return _workersSubdomainCache;
  } catch {
    return undefined;
  }
}

/**
 * Warm all caches from D1. Call once at the top of request/cron handlers.
 *
 * Resolution order:
 *   1. Module-level cache (hot path — no I/O)
 *   2. D1 settings table (persisted by wizard)
 *   3. Cloudflare API (zone_id + account_id only)
 *   4. Derived defaults (reports_domain, from_email)
 *
 * After resolution, zone_id and account_id are persisted to D1 so subsequent
 * cold starts skip the API call.
 */
export async function enrichEnv(env: Env, db?: D1Database): Promise<void> {
  const effectiveDb = db ?? env.DB;

  // 1. Load from D1 if we have a database and any cache is empty
  if (effectiveDb && (!_baseDomainCache || !_zoneIdCache || !_accountIdCache || !_reportsDomainCache || !_fromEmailCache || !_workersSubdomainCache)) {
    const settings = await getSettings(effectiveDb, [
      'base_domain', 'zone_id', 'account_id', 'reports_domain', 'from_email', 'workers_subdomain',
    ]);

    if (!_baseDomainCache) _baseDomainCache = settings.get('base_domain');
    if (!_zoneIdCache) _zoneIdCache = settings.get('zone_id');
    if (!_accountIdCache) _accountIdCache = settings.get('account_id');
    if (!_reportsDomainCache) _reportsDomainCache = settings.get('reports_domain');
    if (!_fromEmailCache) _fromEmailCache = settings.get('from_email');
    if (!_workersSubdomainCache) _workersSubdomainCache = settings.get('workers_subdomain');
  }

  // 2. Resolve zone_id + account_id via API if still missing
  if ((!_zoneIdCache || !_accountIdCache) && _baseDomainCache && env.CLOUDFLARE_API_TOKEN) {
    await resolveZoneId(env.CLOUDFLARE_API_TOKEN);
  }

  // 2b. Resolve workers subdomain via API if still missing
  if (!_workersSubdomainCache && _accountIdCache && env.CLOUDFLARE_API_TOKEN) {
    await resolveWorkersSubdomain(env.CLOUDFLARE_API_TOKEN);
  }

  // 3. Derive defaults
  if (!_reportsDomainCache && _baseDomainCache) {
    _reportsDomainCache = `reports.${_baseDomainCache}`;
  }
  if (!_fromEmailCache && _baseDomainCache) {
    _fromEmailCache = `noreply@reports.${_baseDomainCache}`;
  }

  // 4. Persist resolved values to D1 (fire-and-forget, non-blocking)
  if (effectiveDb && _zoneIdCache && _accountIdCache) {
    const topersist: Record<string, string> = {
      zone_id: _zoneIdCache,
      account_id: _accountIdCache,
    };
    if (_workersSubdomainCache) topersist.workers_subdomain = _workersSubdomainCache;
    persistConfig(effectiveDb, topersist).catch(() => {});
  }
}

/**
 * Reset module-level caches. Call after wizard sets a new base_domain.
 */
export function resetEnvCache(): void {
  _zoneIdCache = undefined;
  _accountIdCache = undefined;
  _baseDomainCache = undefined;
  _reportsDomainCache = undefined;
  _fromEmailCache = undefined;
  _workersSubdomainCache = undefined;
}
