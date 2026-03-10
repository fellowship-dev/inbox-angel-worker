// REST API router for InboxAngel Worker.
// All /api/* routes require authentication via requireAuth().
// Auth provider is pluggable — see src/api/auth.ts.
//
// Unauthenticated:
//   GET  /health                              — liveness probe
//   GET  /api/version                         — running vs latest version
//   POST /api/check-sessions                  — create a free-check session
//   GET  /api/check-sessions/:token           — poll for free-check result
//   POST /api/monitor                         — subscribe to change alerts (unauthenticated)
//   GET  /api/auth/status                     — any admin configured? + env prefill
//   POST /api/auth/setup                      — first-time admin creation
//   POST /api/auth/login                      — password login → session token
//   POST /api/auth/logout                     — clear session token
//   POST /api/auth/forgot                     — send password reset email
//   POST /api/auth/reset                      — set new password via reset token
//   GET  /api/invites/:token                  — invite info
//   POST /api/invites/:token/accept           — accept invite + create user
//   GET  /api/init-key                        — auto-generated API key (no API_KEY set)
//
// Authenticated:
//   GET    /api/domains                       — list domains
//   POST   /api/domains                       — add a domain
//   DELETE /api/domains/:id                   — remove a domain
//   GET    /api/domains/:id/stats             — daily pass/fail stats (days, max 90)
//   GET    /api/domains/:id/reports?date=     — report sources for a specific date
//   GET    /api/domains/:id/sources           — top failing sources (days, max 90)
//   GET    /api/domains/:id/explore           — all sources with pass/fail (days, max 90)
//   GET    /api/domains/:id/anomalies         — failing sources with Active/Older split
//   GET    /api/domains/:id/export            — CSV export
//   GET    /api/domains/:id/dns-check         — check _dmarc TXT record in DNS
//   GET    /api/audit-log                     — immutable audit log (admin only)
//   GET    /api/domains/:id/spf-flatten       — SPF flatten config + availability
//   POST   /api/domains/:id/spf-flatten       — enable SPF flattening (triggers initial flatten)
//   DELETE /api/domains/:id/spf-flatten       — disable + restore canonical record
//   GET    /api/domains/:id/monitor-subs      — list monitoring subscriptions
//   PATCH  /api/domains/:id/alerts            — toggle domain-level alerts on/off
//   PATCH  /api/monitor-subs/:id             — toggle subscription active status
//   GET    /api/reports                       — list recent aggregate reports
//   GET    /api/reports/:id                   — single report with per-IP records
//   GET    /api/check-results                 — recent free check results (last 20)
//   GET    /api/team                          — list users (admin only)
//   POST   /api/team/invite                   — send invite link (admin only)
//   DELETE /api/team/:id                      — remove team member (admin only)
//
// Self-hosted lazy init: if BASE_DOMAIN env var is set and no customer exists yet,
// the first authenticated request auto-provisions customer + domain (no bootstrap call needed).

import { Env } from '../index';
import { requireAuth, AuthError } from './auth';
import { version } from '../../package.json';
import {
  getDomainsByCustomer,
  getDomainById,
  insertDomain,
  updateDomainDnsRecord,
  updateDomainDmarcPolicy,
  updateDomainSpfLookupCount,
  getRecentReports,
  getCheckResultByToken,
  insertMonitorSubscription,
  upsertCustomer,
  getDomainStats,
  getTopFailingSources,
  getReportSourcesByDate,
  getDayReportSummary,
  getDomainExportData,
  getAnomalySources,
  getAllSources,
  getSetting,
  setSetting,
  getMonitorSubsByDomain,
  setMonitorSubActive,
  setDomainAlertsEnabled,
  getUserByEmail,
  getUserBySession,
  getAllUsers,
  insertUser,
  setUserSession,
  deleteUser,
  getInvite,
  insertInvite,
  markInviteUsed,
  insertPasswordResetToken,
  getPasswordResetToken,
  markResetTokenUsed,
} from '../db/queries';
import { hashPassword, verifyPassword } from './password';
import type { DnsProvisionResult } from '../dns/provision';
import { provisionDomain, deprovisionDomain, DnsProvisionError } from '../dns/provision';
import { ensureEmailRouting, registerEmailRoutingDestination } from '../setup/email-routing';
import { track } from '../telemetry';
import { debug } from '../debug';
import { reportsDomain, fromEmail, enrichEnv, getZoneId, getAccountId } from '../env-utils';
import { logAudit } from '../audit/log';
import { flattenSpf, restoreSpf } from '../email/spf-flattener';
import { lookupSpf } from '../email/dns-check';
import {
  provisionMtaSts,
  updateMtaStsTxtRecord,
  deprovisionMtaSts,
  discoverMxHosts,
  generatePolicyId,
  buildPolicyFile,
  patchCfDnsRecord,
} from '../email/mta-sts';
import {
  getSpfFlattenConfig,
  upsertSpfFlattenConfig,
  updateSpfFlattenResult,
  updateSpfFlattenError,
  deleteSpfFlattenConfig,
  getMtaStsConfig,
  insertMtaStsConfig,
  updateMtaStsMode,
  updateMtaStsMxHosts,
  deleteMtaStsConfig,
  getTlsReportSummary,
  getAuditLog,
} from '../db/queries';

// ── Helpers ───────────────────────────────────────────────────

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

async function parseBody<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw { status: 400, message: 'Invalid JSON body' };
  }
}

// ── Route handlers ────────────────────────────────────────────

async function getDomains(env: Env, customerId: string): Promise<Response> {
  const { results } = await getDomainsByCustomer(env.DB, customerId);
  return json({ domains: results });
}

async function addDomain(request: Request, env: Env, customerId: string, userEmail?: string, ctx?: ExecutionContext, actorId?: string): Promise<Response> {
  const body = await parseBody<{ domain?: string }>(request);
  if (!body.domain || typeof body.domain !== 'string') {
    return err('domain is required', 400);
  }

  const domain = body.domain.toLowerCase().trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return err('invalid domain format', 400);
  }

  const rdomain = reportsDomain(env);
  if (!rdomain) return err('REPORTS_DOMAIN is not configured', 500);

  // On first domain add, auto-configure email routing (idempotent)
  const { results: existing } = await getDomainsByCustomer(env.DB, customerId);
  if (existing.length === 0) {
    debug(env, 'domain.add', { step: 'email-routing-setup', firstDomain: true });
    await ensureEmailRouting(env).catch(e => {
      debug(env, 'domain.add', { step: 'email-routing-setup', error: e instanceof Error ? e.message : String(e) });
      console.error('[setup] email routing setup failed (non-fatal):', e);
    });
  }

  // Fixed rua address — routing is by XML policy_domain, not by address encoding
  const ruaAddress = `rua@${rdomain}`;

  // Provision the cross-domain DMARC authorization record.
  // If CF creds are absent, returns manual mode — caller gets instructions instead of auto-record.
  // If CF creds present but API fails, bail before touching the DB.
  let provision: DnsProvisionResult;
  try {
    provision = await provisionDomain(env, domain);
    debug(env, 'domain.add', { step: 'dns-provision', domain, manual: provision.manual, recordName: provision.recordName });
  } catch (e) {
    if (e instanceof DnsProvisionError) {
      debug(env, 'domain.add', { step: 'dns-provision', error: e.message });
      console.error('DNS provision failed:', e.message);
      return err('DNS provisioning failed — check Cloudflare credentials', 502);
    }
    throw e;
  }

  // Insert domain row
  let domainId: number;
  try {
    const result = await insertDomain(env.DB, { customer_id: customerId, domain, rua_address: ruaAddress });
    domainId = result.meta.last_row_id as number;
  } catch (e: any) {
    // Rollback: clean up the DNS record we just created (no-op in manual mode)
    if (provision.recordId) await deprovisionDomain(env, provision.recordId).catch(() => {});
    if (e?.message?.includes('UNIQUE')) return err('domain already registered', 409);
    throw e;
  }

  // Record the CF DNS record ID for future cleanup (only when auto-provisioned)
  if (provision.recordId) {
    await updateDomainDnsRecord(env.DB, domainId, provision.recordId).catch(e =>
      console.warn('updateDomainDnsRecord failed (non-fatal):', e)
    );
  }

  track(env, { event: 'domain.add' }); // fire-and-forget, non-blocking

  logAudit(env.DB!, {
    customer_id: customerId,
    actor_id: actorId ?? null, actor_email: userEmail ?? null, actor_type: 'user',
    action: 'domain.add',
    resource_type: 'domain', resource_id: String(domainId), resource_name: domain,
    after_value: { domain, rua_address: ruaAddress },
  }, ctx);

  if (!provision.manual && provision.recordId) {
    logAudit(env.DB!, {
      customer_id: customerId,
      actor_id: actorId ?? null, actor_email: userEmail ?? null, actor_type: 'user',
      action: 'dns.create',
      resource_type: 'dns_record', resource_id: provision.recordId, resource_name: provision.recordName,
      after_value: { type: 'TXT', name: provision.recordName, content: 'v=DMARC1;', ttl: 3600 },
    }, ctx);
  }

  // Auto-subscribe the adding user to monitoring alerts
  const email = userEmail;
  if (email) {
    await insertMonitorSubscription(env.DB, {
      email: email.toLowerCase().trim(),
      domain,
      session_token: null,
      spf_record: null,
      dmarc_policy: null,
      dmarc_pct: null,
      dmarc_record: null,
    }).catch(e => console.warn('[domain.add] monitor sub insert failed (non-fatal):', e));
  }

  // Background SPF lookup — fire-and-forget, doesn't block response
  if (ctx) {
    ctx.waitUntil(
      lookupSpf(domain)
        .then(spf => {
          if (spf?.lookup_count !== undefined) {
            return updateDomainSpfLookupCount(env.DB!, domainId, spf.lookup_count);
          }
        })
        .catch(e => console.warn('[domain.add] background SPF walk failed (non-fatal):', e))
    );
  }

  // Return the full domain row so the frontend has the ID
  const domainRow = await getDomainById(env.DB, domainId);

  const response: Record<string, unknown> = {
    domain: domainRow,
    rua_hint: `Add rua=mailto:${ruaAddress} to your DMARC record`,
    auth_record: provision.recordName,
  };
  if (provision.manual) {
    response.manual_dns = true;
    response.dns_instructions = `Add this TXT record to authorize DMARC reports:\n  ${provision.recordName}  TXT  "v=DMARC1;"`;
  }
  return json(response, 201);
}

async function deleteDomain(env: Env, customerId: string, domainId: string, actor?: { id?: string; email?: string }, ctx?: ExecutionContext): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  // Verify ownership and fetch the DNS record ID in one query
  const domain = await getDomainById(env.DB, id);
  if (!domain || domain.customer_id !== customerId) return err('domain not found', 404);

  await env.DB.prepare('DELETE FROM domains WHERE id = ? AND customer_id = ?')
    .bind(id, customerId)
    .run();

  logAudit(env.DB!, {
    customer_id: customerId,
    actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: 'user',
    action: 'domain.remove',
    resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
    before_value: { domain: domain.domain, rua_address: domain.rua_address },
  }, ctx);

  // Best-effort cleanup of the CF DNS record (non-fatal if it fails)
  if (domain.dns_record_id) {
    const rdomain = reportsDomain(env);
    const recordName = rdomain ? `${domain.domain}._report._dmarc.${rdomain}` : domain.dns_record_id;
    logAudit(env.DB!, {
      customer_id: customerId,
      actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: 'user',
      action: 'dns.delete',
      resource_type: 'dns_record', resource_id: domain.dns_record_id, resource_name: recordName,
      before_value: { type: 'TXT', name: recordName, content: 'v=DMARC1;', ttl: 3600 },
    }, ctx);
    await deprovisionDomain(env, domain.dns_record_id).catch(e =>
      console.warn(`deprovisionDomain failed for domain ${id}:`, e)
    );
  }

  return new Response(null, { status: 204 });
}

async function getReports(env: Env, customerId: string, url: URL): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '30', 10), 100);
  const { results } = await getRecentReports(env.DB, customerId, limit);
  return json({ reports: results });
}

async function getReport(env: Env, customerId: string, reportId: string): Promise<Response> {
  const id = parseInt(reportId, 10);
  if (isNaN(id)) return err('invalid report id', 400);

  const report = await env.DB
    .prepare('SELECT r.*, d.domain FROM aggregate_reports r JOIN domains d ON d.id = r.domain_id WHERE r.id = ? AND r.customer_id = ?')
    .bind(id, customerId)
    .first();

  if (!report) return err('report not found', 404);

  const { results: records } = await env.DB
    .prepare('SELECT * FROM report_records WHERE report_id = ? ORDER BY count DESC')
    .bind(id)
    .all();

  return json({ report, records });
}

// ── Self-hosted lazy init ──────────────────────────────────────
// When BASE_DOMAIN env var is set and no customer/domain exists yet,
// auto-provision on the first authenticated request — no bootstrap API call needed.

async function ensureCustomerExists(env: Env, _customerId: string): Promise<void> {
  if (!env.BASE_DOMAIN) return; // hosted/multi-tenant mode — nothing to auto-init

  // Always use BASE_DOMAIN as the stable customer ID for single-tenant mode.
  // This prevents customer records from fragmenting across session/key changes.
  const customerId = env.BASE_DOMAIN;
  const { results } = await getDomainsByCustomer(env.DB, customerId);
  if (results.length > 0) return; // already set up

  const domain = env.BASE_DOMAIN.toLowerCase().trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    console.warn('[init] BASE_DOMAIN is invalid, skipping auto-provision:', domain);
    return;
  }
  const rd = reportsDomain(env);
  if (!rd) {
    console.warn('[init] REPORTS_DOMAIN is not set and BASE_DOMAIN is missing, skipping auto-provision');
    return;
  }

  // Use the admin user's name/email for the customer record — they exist by this point
  const admin = await env.DB!.prepare(`SELECT name, email FROM users WHERE role = 'admin' LIMIT 1`).first<{ name: string; email: string }>();
  await upsertCustomer(env.DB, {
    id: customerId,
    name: admin?.name?.trim() || 'Self-hosted',
    email: admin?.email?.trim() || fromEmail(env),
    plan: 'self-hosted',
  });

  const ruaAddress = `rua@${rd}`;
  const provision = await provisionDomain({ ...env, REPORTS_DOMAIN: rd }, domain);
  const result = await insertDomain(env.DB, { customer_id: customerId, domain, rua_address: ruaAddress });

  if (provision.recordId) {
    await updateDomainDnsRecord(env.DB, result.meta.last_row_id as number, provision.recordId).catch(() => {});
  }

  if (provision.manual) {
    console.log(`[init] Domain provisioned. Add this DNS record manually:\n  ${provision.recordName}  TXT  "v=DMARC1;"`);
  } else {
    console.log(`[init] Domain provisioned with DNS record: ${provision.recordName}`);
  }

  // Provision inbox-angel.<BASE_DOMAIN> as a CF Custom Domain for this Worker
  if (env.CLOUDFLARE_API_TOKEN && getZoneId()) {
    try {
      const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? getAccountId();

      if (accountId) {
        const workerName = env.WORKER_NAME ?? 'inbox-angel-worker';
        const hostname = `inbox-angel.${domain}`;
        const domainRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ environment: 'production', hostname, service: workerName, zone_id: getZoneId() }),
        });
        const domainData = await domainRes.json() as { success: boolean; errors?: { message: string }[] };
        if (domainData.success) {
          await setSetting(env.DB, 'custom_domain', hostname);
          console.log(`[init] Custom domain registered: ${hostname}`);
        } else {
          console.warn('[init] Custom domain registration failed:', domainData.errors);
        }

        // Provision Turnstile widget for the login form (non-fatal)
        try {
          const existing = await getSetting(env.DB, 'turnstile_site_key');
          if (!existing) {
            const tsRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/challenges/widgets`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: 'InboxAngel login',
                domains: [hostname],
                mode: 'managed',
                bot_fight_mode: false,
              }),
            });
            const tsData = await tsRes.json() as { result?: { sitekey: string; secret: string } };
            if (tsData.result?.sitekey && tsData.result?.secret) {
              await setSetting(env.DB, 'turnstile_site_key', tsData.result.sitekey);
              await setSetting(env.DB, 'turnstile_secret_key', tsData.result.secret);
              console.log('[init] Turnstile widget provisioned');
            }
          }
        } catch (e) {
          console.warn('[init] Turnstile provisioning failed (non-fatal):', e);
        }
      }
    } catch (e) {
      console.warn('[init] Custom domain provisioning failed (non-fatal):', e);
    }
  }
}

async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    });
    const data = await res.json() as { success: boolean };
    return data.success;
  } catch {
    return false;
  }
}

async function getCheckResults(env: Env, customerId: string): Promise<Response> {
  // Check results are anonymous — only expose if the customer matches their own domain
  // For now: return the last 20 results for domains owned by this customer
  const { results: domains } = await getDomainsByCustomer(env.DB, customerId);
  const domainNames = domains.map(d => d.domain);

  if (domainNames.length === 0) return json({ results: [] });

  const placeholders = domainNames.map(() => '?').join(', ');
  const { results } = await env.DB
    .prepare(`SELECT * FROM check_results WHERE from_domain IN (${placeholders}) ORDER BY created_at DESC LIMIT 20`)
    .bind(...domainNames)
    .all();

  return json({ results });
}

async function getDomainStatsSummary(env: Env, customerId: string, domainId: string, url: URL): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const domain = await getDomainById(env.DB, id);
  if (!domain || domain.customer_id !== customerId) return err('domain not found', 404);

  const rawDays = parseInt(url.searchParams.get('days') ?? '30', 10);
  const days = Math.min(isNaN(rawDays) ? 30 : rawDays, 90);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const { results } = await getDomainStats(env.DB, id, since);
  return json({ domain: domain.domain, days, stats: results });
}

async function exportDomainData(env: Env, customerId: string, domainId: string): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const domain = await getDomainById(env.DB, id);
  if (!domain || domain.customer_id !== customerId) return err('domain not found', 404);

  const { results } = await getDomainExportData(env.DB, id);

  const header = 'date,org_name,total_count,pass_count,fail_count,source_ip,header_from,spf_result,spf_domain,dkim_result,dkim_domain,record_count,disposition\n';
  const rows = results.map(r =>
    [r.date, r.org_name, r.total_count, r.pass_count, r.fail_count,
     r.source_ip ?? '', r.header_from ?? '', r.spf_result ?? '', r.spf_domain ?? '',
     r.dkim_result ?? '', r.dkim_domain ?? '', r.record_count ?? '', r.disposition ?? '']
    .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  ).join('\n');

  const filename = `${domain.domain}-dmarc.csv`;
  return new Response(header + rows, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

async function getDomainReportByDate(env: Env, customerId: string, domainId: string, url: URL): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const date = url.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('date param required (YYYY-MM-DD)', 400);

  const domain = await getDomainById(env.DB, id);
  if (!domain || domain.customer_id !== customerId) return err('domain not found', 404);

  const [summary, { results: sources }] = await Promise.all([
    getDayReportSummary(env.DB, id, date),
    getReportSourcesByDate(env.DB, id, date),
  ]);

  return json({ date, domain: domain.domain, summary: summary ?? { total: 0, passed: 0, failed: 0 }, sources });
}

async function getDomainSources(env: Env, customerId: string, domainId: string, url: URL): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const domain = await getDomainById(env.DB, id);
  if (!domain || domain.customer_id !== customerId) return err('domain not found', 404);

  const rawDays = parseInt(url.searchParams.get('days') ?? '7', 10);
  const days = Math.min(isNaN(rawDays) ? 7 : rawDays, 90);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const { results } = await getTopFailingSources(env.DB, id, since);
  return json({ sources: results });
}

// ── Main router ───────────────────────────────────────────────

export async function handleApi(
  request: Request,
  envRaw: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const res = await _handleApi(request, envRaw, ctx);
  return withSecurityHeaders(res);
}

async function _handleApi(
  request: Request,
  envRaw: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const env = await enrichEnv(envRaw);
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  // Global rate limit — 200 req/min per IP (covers all routes including unauthenticated)
  if (env.API_LIMITER) {
    const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
    const { success } = await env.API_LIMITER.limit({ key: ip });
    if (!success) return err('too many requests', 429);
  }

  // Unauthenticated routes
  if (path === '/health' && method === 'GET') {
    return json({ ok: true, version, ts: Date.now() });
  }

  // GET /api/version — compares running version against latest GitHub release
  // Cached for 24h per-instance via CF Cache API — one GitHub request per day max
  if (path === '/api/version' && method === 'GET') {
    const GH_RAW = 'https://raw.githubusercontent.com/Fellowship-dev/inbox-angel-worker/main/package.json';
    const cacheKey = new Request(GH_RAW);
    let latest: string | null = null;
    try {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        const pkg = await cached.json() as { version: string };
        latest = pkg.version;
      } else {
        const res = await fetch(GH_RAW);
        if (res.ok) {
          const pkg = await res.json() as { version: string };
          latest = pkg.version;
          ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(pkg), {
            headers: { 'Cache-Control': 'max-age=86400', 'Content-Type': 'application/json' },
          })));
        }
      }
    } catch { /* GitHub unreachable — return current only */ }
    return json({
      current: version,
      latest,
      update_available: latest !== null && latest !== version,
      release_url: 'https://github.com/Fellowship-dev/inbox-angel-worker/releases/latest',
    });
  }

  // POST /api/check-sessions — generate a unique free-check email for a browser session
  if (path === '/api/check-sessions' && method === 'POST') {
    const rd = reportsDomain(env);
    if (!rd) return err('REPORTS_DOMAIN is not configured', 500);
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const token = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map(b => chars[b % chars.length]).join('');
    track(env, { event: 'check.created' }); // fire-and-forget
    return json({ token, email: `${token}@${rd}` }, 201);
  }

  // GET /api/check-sessions/:token — poll until the check email has been processed
  const sessionMatch = path.match(/^\/api\/check-sessions\/([^/]+)$/);
  if (sessionMatch && method === 'GET') {
    const result = await getCheckResultByToken(env.DB, sessionMatch[1]);
    if (!result) return json({ status: 'pending' }, 202);
    return json({ status: 'done', result });
  }

  // POST /api/monitor — subscribe to change alerts for a domain (unauthenticated)
  if (path === '/api/monitor' && method === 'POST') {
    const body = await parseBody<{ email?: string; session_token?: string }>(request);
    if (!body.email || !body.session_token) return err('email and session_token are required', 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return err('invalid email', 400);

    const checkResult = await getCheckResultByToken(env.DB, body.session_token);
    if (!checkResult) return err('check result not found — send the test email first', 404);

    await insertMonitorSubscription(env.DB, {
      email: body.email.toLowerCase().trim(),
      domain: checkResult.from_domain,
      session_token: body.session_token,
      spf_record: checkResult.spf_record,
      dmarc_policy: checkResult.dmarc_policy,
      dmarc_pct: null,  // not stored in check_results; will be populated on first cron run
      dmarc_record: checkResult.dmarc_record,
    });

    return json({ domain: checkResult.from_domain, email: body.email }, 201);
  }

  // GET /api/auth/status — any admin configured? + env prefill
  if (path === '/api/auth/status' && method === 'GET') {
    const admin = await env.DB!.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).first();
    const [tsKeyRow, customDomainRow] = await Promise.all([
      getSetting(env.DB!, 'turnstile_site_key'),
      getSetting(env.DB!, 'custom_domain'),
    ]);
    return json({
      configured: !!admin,
      prefill: { name: '', email: '' },
      telemetry_default: env.TELEMETRY_ENABLED === 'true',
      turnstile_site_key: tsKeyRow?.value ?? null,
      custom_domain: customDomainRow?.value ?? null,
    });
  }

  // POST /api/auth/setup — first-time admin creation (only if no users exist)
  if (path === '/api/auth/setup' && method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (env.AUTH_LIMITER) {
      const { success } = await env.AUTH_LIMITER.limit({ key: ip });
      if (!success) return err('Too many requests — try again later', 429);
    }
    const admin = await env.DB!.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).first();
    if (admin) return err('already configured — use /api/auth/login', 409);

    const body = await parseBody<{ name?: string; email?: string; password?: string; telemetry?: boolean; cf_turnstile_token?: string }>(request);
    if (!body.email || !body.password) return err('email and password are required', 400);
    if (body.password.length < 8) return err('password must be at least 8 characters', 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return err('invalid email', 400);

    const tsSecretRow = await getSetting(env.DB!, 'turnstile_secret_key');
    if (tsSecretRow?.value) {
      const tsToken = body.cf_turnstile_token;
      if (!tsToken) return err('Bot check failed', 403);
      const ip = request.headers.get('CF-Connecting-IP') ?? '';
      const valid = await verifyTurnstile(tsToken, tsSecretRow.value, ip);
      if (!valid) return err('Bot check failed', 403);
    }

    const hash = await hashPassword(body.password);
    const token = crypto.randomUUID();
    const id = crypto.randomUUID();
    const email = body.email.toLowerCase().trim();

    await insertUser(env.DB!, { id, email, name: body.name?.trim() || email, password_hash: hash, role: 'admin' });
    await setUserSession(env.DB!, id, token);
    if (body.telemetry !== undefined) await setSetting(env.DB!, 'telemetry_opted_in', body.telemetry ? 'true' : 'false');

    logAudit(env.DB!, {
      customer_id: env.BASE_DOMAIN ?? 'system',
      actor_id: id, actor_email: email, actor_type: 'user',
      action: 'auth.setup',
      resource_type: 'user', resource_id: id, resource_name: email,
      after_value: { email, role: 'admin' },
      meta: { ip },
    }, ctx);
    track(env, { event: 'instance.born' }); // fire-and-forget

    // Register user's email as a CF Email Routing destination so they only need to click a link
    let email_verification_sent = false;
    const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? getAccountId();
    if (env.CLOUDFLARE_API_TOKEN && accountId) {
      email_verification_sent = await registerEmailRoutingDestination(env.CLOUDFLARE_API_TOKEN, accountId, email);
    }

    return json({ token, email_verification_sent }, 201);
  }

  // POST /api/auth/login — verify password → new session token
  if (path === '/api/auth/login' && method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (env.AUTH_LIMITER) {
      const { success } = await env.AUTH_LIMITER.limit({ key: ip });
      if (!success) return err('Too many requests — try again later', 429);
    }
    const body = await parseBody<{ email?: string; password?: string; cf_turnstile_token?: string }>(request);
    if (!body.email || !body.password) return err('email and password are required', 400);

    const tsSecretRow = await getSetting(env.DB!, 'turnstile_secret_key');
    if (tsSecretRow?.value) {
      const tsToken = body.cf_turnstile_token;
      if (!tsToken) return err('Bot check failed', 403);
      const ip = request.headers.get('CF-Connecting-IP') ?? '';
      const valid = await verifyTurnstile(tsToken, tsSecretRow.value, ip);
      if (!valid) return err('Bot check failed', 403);
    }

    const user = await getUserByEmail(env.DB!, body.email.toLowerCase().trim());
    if (!user || !user.password_hash) return err('invalid credentials', 401);

    const valid = await verifyPassword(body.password, user.password_hash);
    if (!valid) return err('invalid credentials', 401);

    const token = crypto.randomUUID();
    await setUserSession(env.DB!, user.id, token);
    logAudit(env.DB!, {
      customer_id: env.BASE_DOMAIN ?? 'system',
      actor_id: user.id, actor_email: user.email, actor_type: 'user',
      action: 'auth.login',
      resource_type: 'user', resource_id: user.id, resource_name: user.email,
      meta: { ip: request.headers.get('CF-Connecting-IP') ?? 'unknown' },
    }, ctx);
    return json({ token });
  }

  // POST /api/auth/logout — clear session token
  if (path === '/api/auth/logout' && method === 'POST') {
    const key = request.headers.get('x-api-key') ?? '';
    const user = await getUserBySession(env.DB!, key);
    if (user) {
      await setUserSession(env.DB!, user.id, null);
      logAudit(env.DB!, {
        customer_id: env.BASE_DOMAIN ?? 'system',
        actor_id: user.id, actor_email: user.email, actor_type: 'user',
        action: 'auth.logout',
        resource_type: 'user', resource_id: user.id, resource_name: user.email,
      }, ctx);
    }
    return json({ ok: true });
  }

  // POST /api/auth/forgot — generate reset token + send email
  if (path === '/api/auth/forgot' && method === 'POST') {
    const body = await parseBody<{ email?: string }>(request);
    if (!body.email) return err('email is required', 400);

    const user = await getUserByEmail(env.DB!, body.email.toLowerCase().trim());
    // Always return 200 — don't reveal whether email exists
    if (user) {
      const token = crypto.randomUUID();
      const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour
      await insertPasswordResetToken(env.DB!, token, user.id, expiresAt);
      logAudit(env.DB!, {
        customer_id: env.BASE_DOMAIN ?? 'system',
        actor_id: user.id, actor_email: user.email, actor_type: 'user',
        action: 'auth.password_reset',
        resource_type: 'user', resource_id: user.id, resource_name: user.email,
        meta: { phase: 'requested' },
      }, ctx);

      const origin = new URL(request.url).origin;
      const resetUrl = `${origin}/#/reset/${token}`;
      const emailBody = `Hi ${user.name},\n\nYou requested a password reset for your InboxAngel account.\n\nClick the link below to set a new password (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, ignore this email — your password won't change.\n\nInboxAngel`;

      const fe = fromEmail(env);
      if (env.SEND_EMAIL && fe) {
        try {
          await env.SEND_EMAIL.send({
            from: { name: 'InboxAngel', email: fe },
            to: [user.email],
            subject: 'Reset your InboxAngel password',
            text: emailBody,
          });
        } catch (e) {
          console.error('[auth] reset email send failed:', e);
        }
      } else {
        console.log(`[auth] reset link for ${user.email}: ${resetUrl}`);
      }
    }
    return json({ ok: true });
  }

  // POST /api/auth/reset — set new password using reset token
  if (path === '/api/auth/reset' && method === 'POST') {
    const body = await parseBody<{ token?: string; password?: string }>(request);
    if (!body.token || !body.password) return err('token and password are required', 400);
    if (body.password.length < 8) return err('password must be at least 8 characters', 400);

    const resetToken = await getPasswordResetToken(env.DB!, body.token);
    if (!resetToken || resetToken.used_at || resetToken.expires_at < Math.floor(Date.now() / 1000)) {
      return err('reset link is invalid or has expired', 400);
    }

    const hash = await hashPassword(body.password);
    const sessionToken = crypto.randomUUID();
    await env.DB!.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(hash, resetToken.user_id).run();
    await setUserSession(env.DB!, resetToken.user_id, sessionToken);
    await markResetTokenUsed(env.DB!, body.token);
    logAudit(env.DB!, {
      customer_id: env.BASE_DOMAIN ?? 'system',
      actor_id: resetToken.user_id, actor_type: 'user',
      action: 'auth.password_reset',
      resource_type: 'user', resource_id: resetToken.user_id,
      meta: { phase: 'completed' },
    }, ctx);
    return json({ token: sessionToken });
  }

  // GET /api/invites/:token — get invite info (unauthenticated, for the accept page)
  const inviteTokenMatch = path.match(/^\/api\/invites\/([^/]+)$/);
  if (inviteTokenMatch && method === 'GET') {
    const invite = await getInvite(env.DB!, inviteTokenMatch[1]);
    if (!invite || invite.used_at || invite.expires_at < Math.floor(Date.now() / 1000)) {
      return err('invite not found or expired', 404);
    }
    return json({ email: invite.email, invited_by: invite.invited_by, role: invite.role });
  }

  // POST /api/invites/:token/accept — set name+password, create user, return session
  if (inviteTokenMatch && method === 'POST') {
    const invite = await getInvite(env.DB!, inviteTokenMatch[1]);
    if (!invite || invite.used_at || invite.expires_at < Math.floor(Date.now() / 1000)) {
      return err('invite not found or expired', 404);
    }
    const body = await parseBody<{ name?: string; password?: string }>(request);
    if (!body.name || !body.password) return err('name and password are required', 400);
    if (body.password.length < 8) return err('password must be at least 8 characters', 400);

    const existing = await getUserByEmail(env.DB!, invite.email);
    if (existing) return err('an account with this email already exists', 409);

    const hash = await hashPassword(body.password);
    const token = crypto.randomUUID();
    const id = crypto.randomUUID();

    await insertUser(env.DB!, { id, email: invite.email, name: body.name.trim(), password_hash: hash, role: invite.role as 'admin' | 'member' });
    await setUserSession(env.DB!, id, token);
    await markInviteUsed(env.DB!, invite.token);
    logAudit(env.DB!, {
      customer_id: env.BASE_DOMAIN ?? 'system',
      actor_id: id, actor_email: invite.email, actor_type: 'user',
      action: 'auth.invite_accepted',
      resource_type: 'user', resource_id: id, resource_name: invite.email,
      after_value: { email: invite.email, role: invite.role, invited_by: invite.invited_by },
    }, ctx);
    return json({ token }, 201);
  }

  // GET /api/init-key — returns the auto-generated API key (only when API_KEY env is not set)
  // Used by the dashboard on first load to pre-fill the API key gate.
  if (path === '/api/init-key' && method === 'GET') {
    if (env.API_KEY) return err('not found', 404); // manual key configured — no auto-key needed
    const row = await getSetting(env.DB!, 'auto_api_key');
    if (!row) return err('not found', 404);
    return json({ key: row.value });
  }

  // All /api/* routes require auth
  if (!path.startsWith('/api/')) {
    return err('not found', 404);
  }

  // Resolve session: env API_KEY override → users table session → legacy auto-key
  const requestKey = request.headers.get('x-api-key') ?? '';
  let effectiveApiKey: string | undefined = env.API_KEY;
  let userBySession: Awaited<ReturnType<typeof getUserBySession>> = null;
  if (!effectiveApiKey) {
    userBySession = await getUserBySession(env.DB!, requestKey);
    if (userBySession) {
      effectiveApiKey = requestKey;
    } else {
      effectiveApiKey = (await getSetting(env.DB!, 'auto_api_key'))?.value;
    }
  }

  let customerId: string;
  try {
    const ctx = await requireAuth(request, { ...env, API_KEY: effectiveApiKey });
    // In single-tenant mode use BASE_DOMAIN as stable ID regardless of session user
    customerId = (env.BASE_DOMAIN && !env.AUTH0_DOMAIN)
      ? env.BASE_DOMAIN
      : ctx.customerId;
    debug(env, 'auth.ok', { method, path, customerId, mode: env.AUTH0_DOMAIN ? 'jwt' : 'api-key' });
  } catch (e) {
    debug(env, 'auth.fail', { method, path, error: e instanceof Error ? e.message : String(e) });
    if (e instanceof AuthError) return err(e.message, e.status);
    return err('authentication error', 401);
  }

  // Self-hosted lazy init — no-op in hosted mode (BASE_DOMAIN unset)
  await ensureCustomerExists(env, customerId);

  try {
    // GET /api/domains
    if (path === '/api/domains' && method === 'GET') {
      return await getDomains(env, customerId);
    }
    // POST /api/domains
    if (path === '/api/domains' && method === 'POST') {
      const userEmail = userBySession?.email;
      return await addDomain(request, env, customerId, userEmail, ctx, userBySession?.id);
    }
    // GET /api/domains/:id/stats
    const domainStatsMatch = path.match(/^\/api\/domains\/([^/]+)\/stats$/);
    if (domainStatsMatch && method === 'GET') {
      return await getDomainStatsSummary(env, customerId, domainStatsMatch[1], url);
    }
    // GET /api/domains/:id/reports?date=YYYY-MM-DD
    const domainReportsMatch = path.match(/^\/api\/domains\/([^/]+)\/reports$/);
    if (domainReportsMatch && method === 'GET') {
      return await getDomainReportByDate(env, customerId, domainReportsMatch[1], url);
    }
    // GET /api/domains/:id/sources
    const domainSourcesMatch = path.match(/^\/api\/domains\/([^/]+)\/sources$/);
    if (domainSourcesMatch && method === 'GET') {
      return await getDomainSources(env, customerId, domainSourcesMatch[1], url);
    }
    // GET /api/domains/:id/explore?days=30
    const exploreMatch = path.match(/^\/api\/domains\/([^/]+)\/explore$/);
    if (exploreMatch && method === 'GET') {
      const id = parseInt(exploreMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
      if (!domain || domain.customer_id !== customerId) return err('domain not found', 404);
      const rawDays = parseInt(url.searchParams.get('days') ?? '30', 10);
      const days = Math.min(isNaN(rawDays) ? 30 : rawDays, 90);
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const { results } = await getAllSources(env.DB, id, since);
      return json({ days, domain: domain.domain, sources: results });
    }
    // GET /api/domains/:id/anomalies?days=30
    const anomaliesMatch = path.match(/^\/api\/domains\/([^/]+)\/anomalies$/);
    if (anomaliesMatch && method === 'GET') {
      const id = parseInt(anomaliesMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
      if (!domain || domain.customer_id !== customerId) return err('domain not found', 404);
      const rawDays = parseInt(url.searchParams.get('days') ?? '30', 10);
      const days = Math.min(isNaN(rawDays) ? 30 : rawDays, 90);
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const { results } = await getAnomalySources(env.DB, id, since);
      return json({ days, domain: domain.domain, anomalies: results });
    }
    // GET /api/domains/:id/export — CSV download (requires normal session/API key auth)
    const exportMatch = path.match(/^\/api\/domains\/([^/]+)\/export$/);
    if (exportMatch && method === 'GET') {
      return await exportDomainData(env, customerId, exportMatch[1]);
    }
    // GET /api/domains/:id/dns-check — check if user has added the _dmarc TXT record
    const dnsCheckMatch = path.match(/^\/api\/domains\/([^/]+)\/dns-check$/);
    if (dnsCheckMatch && method === 'GET') {
      const id = parseInt(dnsCheckMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
      if (!domain || domain.customer_id !== customerId) return err('domain not found', 404);

      try {
        const dohUrl = `https://cloudflare-dns.com/dns-query?name=_dmarc.${domain.domain}&type=TXT`;
        const dohRes = await fetch(dohUrl, { headers: { Accept: 'application/dns-json' } });
        const doh = await dohRes.json() as { Status: number; Answer?: { data: string }[] };
        const records = doh.Answer ?? [];
        const found = records.length > 0;
        const has_rua = records.some(r => r.data.includes(domain.rua_address));
        // Strip surrounding quotes that DoH JSON wraps TXT content in
        const current_record = records[0]?.data?.replace(/^"|"$/g, '') ?? null;
        const cf_managed = !!domain.dns_record_id;
        if (found) track(env, { event: 'domain.dns_verified' }); // fire-and-forget
        return json({ found, has_rua, current_record, cf_managed });
      } catch {
        return json({ found: false, has_rua: false, current_record: null, cf_managed: false, error: 'dns lookup failed' });
      }
    }
    // PATCH /api/domains/:id/dmarc — update DMARC policy via CF DNS (CF-managed domains only)
    const dmarcPatchMatch = path.match(/^\/api\/domains\/([^/]+)\/dmarc$/);
    if (dmarcPatchMatch && method === 'PATCH') {
      const id = parseInt(dmarcPatchMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
      if (!domain || domain.customer_id !== customerId) return err('domain not found', 404);
      if (!domain.dns_record_id) return err('domain is not CF-managed — update DNS manually', 400);
      if (!env.CLOUDFLARE_API_TOKEN) return err('Cloudflare credentials not configured', 400);

      const body = await parseBody<{ policy?: string }>(request);
      const policy = body.policy;
      if (!policy || !['none', 'quarantine', 'reject'].includes(policy)) {
        return err('policy must be none, quarantine, or reject', 400);
      }

      // Build updated TXT record, preserving rua= and any pct= from existing record
      const rd = reportsDomain(env);
      const ruaPart = rd ? `; rua=mailto:${domain.rua_address}` : '';
      const newRecord = `v=DMARC1; p=${policy}${ruaPart}`;

      try {
        await patchCfDnsRecord({ CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN }, domain.dns_record_id, newRecord);
      } catch (e: any) {
        return err(e.message ?? 'CF DNS patch failed', 500);
      }

      const prevPolicy = domain.dmarc_policy ?? 'none';
      await updateDomainDmarcPolicy(env.DB, id, policy);

      logAudit(env.DB, {
        customer_id: customerId,
        actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
        action: 'domain.dmarc_mode_change',
        resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
        before_value: { policy: prevPolicy },
        after_value: { policy, record: newRecord },
      }, ctx);
      track(env, { event: 'domain.dmarc_mode_change', from: prevPolicy, to: policy });

      return json({ ok: true, policy, record: newRecord });
    }

    // DELETE /api/domains/:id
    const domainDeleteMatch = path.match(/^\/api\/domains\/([^/]+)$/);
    if (domainDeleteMatch && method === 'DELETE') {
      return await deleteDomain(env, customerId, domainDeleteMatch[1], { id: userBySession?.id, email: userBySession?.email }, ctx);
    }
    // GET /api/reports
    if (path === '/api/reports' && method === 'GET') {
      return await getReports(env, customerId, url);
    }
    // GET /api/reports/:id
    const reportMatch = path.match(/^\/api\/reports\/([^/]+)$/);
    if (reportMatch && method === 'GET') {
      return await getReport(env, customerId, reportMatch[1]);
    }
    // GET /api/check-results
    if (path === '/api/check-results' && method === 'GET') {
      return await getCheckResults(env, customerId);
    }

    // GET /api/domains/:id/monitor-subs — list monitoring subscriptions for a domain
    const monitorSubsMatch = path.match(/^\/api\/domains\/(\d+)\/monitor-subs$/);
    if (monitorSubsMatch && method === 'GET') {
      const domain = await getDomainById(env.DB, parseInt(monitorSubsMatch[1], 10));
      if (!domain || domain.customer_id !== customerId) return err('domain not found', 404);
      const { results } = await getMonitorSubsByDomain(env.DB, domain.domain);
      return json({ subs: results });
    }

    // PATCH /api/monitor-subs/:id — toggle active status
    const monitorSubPatchMatch = path.match(/^\/api\/monitor-subs\/(\d+)$/);
    if (monitorSubPatchMatch && method === 'PATCH') {
      const body = await parseBody<{ active?: boolean }>(request);
      if (typeof body.active !== 'boolean') return err('active (boolean) is required', 400);
      await setMonitorSubActive(env.DB, parseInt(monitorSubPatchMatch[1], 10), body.active);
      return json({ ok: true });
    }

    // PATCH /api/domains/:id/alerts — toggle domain-level alerts on/off
    const domainAlertsMatch = path.match(/^\/api\/domains\/([^/]+)\/alerts$/);
    if (domainAlertsMatch && method === 'PATCH') {
      const body = await parseBody<{ alerts_enabled?: boolean }>(request);
      if (typeof body.alerts_enabled !== 'boolean') return err('alerts_enabled (boolean) is required', 400);
      await setDomainAlertsEnabled(env.DB, parseInt(domainAlertsMatch[1], 10), body.alerts_enabled);
      return json({ ok: true });
    }

    // GET /api/team — list all users (admin only)
    if (path === '/api/team' && method === 'GET') {
      const actor = await getUserBySession(env.DB, requestKey);
      if (!actor || actor.role !== 'admin') return err('admin required', 403);
      const { results } = await getAllUsers(env.DB);
      return json({ users: results, current_user_id: actor.id });
    }

    // POST /api/team/invite — generate one-time invite link (admin only)
    if (path === '/api/team/invite' && method === 'POST') {
      const actor = await getUserBySession(env.DB, requestKey);
      if (!actor || actor.role !== 'admin') return err('admin required', 403);
      const body = await parseBody<{ email?: string; role?: string }>(request);
      if (!body.email) return err('email is required', 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return err('invalid email', 400);
      const existing = await getUserByEmail(env.DB, body.email.toLowerCase().trim());
      if (existing) return err('a user with this email already exists', 409);

      const token = crypto.randomUUID();
      const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 7 days
      const inviteEmail = body.email.toLowerCase().trim();
      const inviteRole = body.role === 'admin' ? 'admin' : 'member';
      await insertInvite(env.DB, {
        token,
        email: inviteEmail,
        role: inviteRole,
        invited_by: actor.email,
        expires_at: expiresAt,
      });
      logAudit(env.DB, {
        customer_id: customerId,
        actor_id: actor.id, actor_email: actor.email, actor_type: 'user',
        action: 'auth.invite_sent',
        resource_type: 'user', resource_name: inviteEmail,
        after_value: { email: inviteEmail, role: inviteRole, invited_by: actor.email },
      }, ctx);
      return json({ token }, 201);
    }

    // DELETE /api/team/:id — remove a team member (admin only, can't remove self)
    const teamMemberMatch = path.match(/^\/api\/team\/([^/]+)$/);
    if (teamMemberMatch && method === 'DELETE') {
      const actor = await getUserBySession(env.DB, requestKey);
      if (!actor || actor.role !== 'admin') return err('admin required', 403);
      if (actor.id === teamMemberMatch[1]) return err('cannot remove yourself', 400);
      const removed = await getUserByEmail(env.DB, teamMemberMatch[1]).catch(() => null)
        ?? await env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?').bind(teamMemberMatch[1]).first<{ id: string; email: string; name: string; role: string }>().catch(() => null);
      await deleteUser(env.DB, teamMemberMatch[1]);
      logAudit(env.DB, {
        customer_id: customerId,
        actor_id: actor.id, actor_email: actor.email, actor_type: 'user',
        action: 'team.member_removed',
        resource_type: 'user', resource_id: teamMemberMatch[1], resource_name: removed?.email ?? teamMemberMatch[1],
        before_value: removed ? { email: removed.email, name: removed.name, role: removed.role } : null,
      }, ctx);
      return json({ ok: true });
    }

    // SPF flatten routes — GET/POST/DELETE /api/domains/:id/spf-flatten
    const spfFlattenMatch = path.match(/^\/api\/domains\/([^/]+)\/spf-flatten$/);
    if (spfFlattenMatch) {
      const id = parseInt(spfFlattenMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
      if (!domain || domain.customer_id !== customerId) return err('domain not found', 404);

      const available = !!(env.CLOUDFLARE_API_TOKEN && getZoneId());

      // GET — return current config + availability
      if (method === 'GET') {
        const config = await getSpfFlattenConfig(env.DB, id);
        return json({ available, config: config ?? null, lookup_count: domain.spf_lookup_count ?? null });
      }

      // POST — enable + trigger initial flatten
      if (method === 'POST') {
        if (!available) return err('Cloudflare credentials not configured (CLOUDFLARE_API_TOKEN + BASE_DOMAIN required)', 422);

        const flatEnv = {
          CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN!,
        };

        // Walk lookup count first (for display)
        const spfRecord = await lookupSpf(domain.domain);
        const lookup_count = spfRecord?.lookup_count ?? null;

        // Do initial flatten
        let result;
        try {
          result = await flattenSpf(domain.domain, flatEnv);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Save config with error so user can see it
          await upsertSpfFlattenConfig(env.DB, {
            domain_id: id,
            canonical_record: spfRecord?.raw ?? '',
            lookup_count,
            cf_record_id: null,
          });
          await updateSpfFlattenError(env.DB, id, msg);
          return err(msg, 422);
        }

        await upsertSpfFlattenConfig(env.DB, {
          domain_id: id,
          canonical_record: result.canonical_record,
          lookup_count,
          cf_record_id: result.cf_record_id,
        });
        await updateSpfFlattenResult(env.DB, id, result.flattened_record, result.ip_count, result.cf_record_id);

        logAudit(env.DB, {
          customer_id: customerId,
          actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
          action: 'spf_flatten.enable',
          resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
          before_value: { spf_record: result.canonical_record },
          after_value: { spf_record: result.flattened_record, ip_count: result.ip_count },
        }, ctx);
        if (result.cf_record_id) {
          logAudit(env.DB, {
            customer_id: customerId,
            actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
            action: 'dns.update',
            resource_type: 'dns_record', resource_id: result.cf_record_id, resource_name: `TXT _spf.${domain.domain}`,
            before_value: { content: result.canonical_record },
            after_value: { content: result.flattened_record },
          }, ctx);
        }

        track(env, { event: 'spf_flatten.enable' }); // fire-and-forget
        const config = await getSpfFlattenConfig(env.DB, id);
        return json({ ok: true, config }, 201);
      }

      // DELETE — disable + restore canonical record
      if (method === 'DELETE') {
        const config = await getSpfFlattenConfig(env.DB, id);
        if (!config) return err('SPF flattening not configured for this domain', 404);

        if (available && config.cf_record_id && config.canonical_record) {
          try {
            await restoreSpf(domain.domain, config.cf_record_id, config.canonical_record, {
              CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN!,
            });
          } catch (e) {
            console.warn(`[spf-flatten] restore failed for ${domain.domain}:`, e);
            // Non-fatal — delete config anyway so user can retry
          }
        }

        logAudit(env.DB, {
          customer_id: customerId,
          actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
          action: 'spf_flatten.disable',
          resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
          before_value: { spf_record: config.flattened_record ?? config.canonical_record },
          after_value: { spf_record: config.canonical_record },
        }, ctx);
        track(env, { event: 'spf_flatten.disable' }); // fire-and-forget
        await deleteSpfFlattenConfig(env.DB, id);
        return new Response(null, { status: 204 });
      }
    }

    // MTA-STS routes — GET/POST/PATCH/DELETE /api/domains/:id/mta-sts
    const mtaStsMatch = path.match(/^\/api\/domains\/([^/]+)\/mta-sts$/);
    if (mtaStsMatch) {
      const id = parseInt(mtaStsMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
      if (!domain || domain.customer_id !== customerId) return err('domain not found', 404);

      if (method === 'GET') {
        const config = await getMtaStsConfig(env.DB, id);
        const tlsSince = Math.floor(Date.now() / 1000) - 30 * 86400; // last 30 days
        const summary = config ? await getTlsReportSummary(env.DB, id, tlsSince) : null;
        return json({ available: !!(env.CLOUDFLARE_API_TOKEN && getZoneId()), config, summary });
      }

      if (method === 'POST') {
        // Enable MTA-STS
        if (!env.CLOUDFLARE_API_TOKEN || !getZoneId() || !env.REPORTS_DOMAIN) {
          return err('Cloudflare credentials not configured', 400);
        }
        const existing = await getMtaStsConfig(env.DB, id);
        if (existing?.enabled) return err('MTA-STS already enabled for this domain', 409);

        try {
          const result = await provisionMtaSts(domain.domain, {
            CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
            REPORTS_DOMAIN: reportsDomain(env)!,
            WORKER_NAME: env.WORKER_NAME ?? 'inbox-angel-worker',
          });
          await insertMtaStsConfig(env.DB, {
            domain_id: id,
            mode: result.mode,
            mx_hosts: result.mx_hosts.join(','),
            policy_id: result.policy_id,
            mta_sts_record_id: result.mta_sts_record_id,
            tls_rpt_record_id: result.tls_rpt_record_id,
            cname_record_id: result.cname_record_id,
          });
          const rd = reportsDomain(env)!;
          logAudit(env.DB, {
            customer_id: customerId,
            actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
            action: 'mta_sts.enable',
            resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
            after_value: { mode: result.mode, mx_hosts: result.mx_hosts, policy_id: result.policy_id },
          }, ctx);
          // Log each DNS record created
          logAudit(env.DB, { customer_id: customerId, actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.create', resource_type: 'dns_record', resource_id: result.mta_sts_record_id, resource_name: `_mta-sts.${domain.domain}`, after_value: { type: 'TXT', name: `_mta-sts.${domain.domain}`, content: `v=STSv1; id=${result.policy_id}` } }, ctx);
          logAudit(env.DB, { customer_id: customerId, actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.create', resource_type: 'dns_record', resource_id: result.tls_rpt_record_id, resource_name: `_smtp._tls.${domain.domain}`, after_value: { type: 'TXT', name: `_smtp._tls.${domain.domain}`, content: `v=TLSRPTv1; rua=mailto:tls-rpt@${rd}` } }, ctx);
          logAudit(env.DB, { customer_id: customerId, actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.create', resource_type: 'dns_record', resource_id: result.cname_record_id, resource_name: `mta-sts.${domain.domain}`, after_value: { type: 'CNAME', name: `mta-sts.${domain.domain}`, proxied: true } }, ctx);
          track(env, { event: 'mta_sts.enable' }); // fire-and-forget
          return json({ ok: true, mode: result.mode, mx_hosts: result.mx_hosts });
        } catch (e: any) {
          return err(e.message ?? 'provisioning failed', 500);
        }
      }

      if (method === 'PATCH') {
        // Update mode (testing → enforce) or refresh MX hosts
        const config = await getMtaStsConfig(env.DB, id);
        if (!config?.enabled) return err('MTA-STS not enabled for this domain', 404);
        if (!env.CLOUDFLARE_API_TOKEN || !getZoneId()) return err('Cloudflare credentials not configured', 400);

        const body = await parseBody<{ mode?: string; refresh_mx?: boolean }>(request);
        const patchEnv = { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN };

        if (body.mode && (body.mode === 'testing' || body.mode === 'enforce')) {
          const newPolicyId = generatePolicyId();
          await updateMtaStsTxtRecord(config.mta_sts_record_id!, newPolicyId, patchEnv);
          await updateMtaStsMode(env.DB, id, body.mode, newPolicyId);
          logAudit(env.DB, {
            customer_id: customerId,
            actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
            action: 'mta_sts.mode_change',
            resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
            before_value: { mode: config.mode, policy_id: config.policy_id },
            after_value: { mode: body.mode, policy_id: newPolicyId },
          }, ctx);
          if (config.mta_sts_record_id) {
            logAudit(env.DB, { customer_id: customerId, actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.update', resource_type: 'dns_record', resource_id: config.mta_sts_record_id, resource_name: `_mta-sts.${domain.domain}`, before_value: { content: `v=STSv1; id=${config.policy_id}` }, after_value: { content: `v=STSv1; id=${newPolicyId}` } }, ctx);
          }
          track(env, { event: 'mta_sts.mode_change', from: config.mode, to: body.mode }); // fire-and-forget
          return json({ ok: true, mode: body.mode, policy_id: newPolicyId });
        }

        if (body.refresh_mx) {
          const oldMxHosts = config.mx_hosts ? config.mx_hosts.split(',').filter(Boolean) : [];
          const mxHosts = await discoverMxHosts(domain.domain);
          if (mxHosts.length === 0) return err('No MX records found', 400);
          const newPolicyId = generatePolicyId();
          await updateMtaStsTxtRecord(config.mta_sts_record_id!, newPolicyId, patchEnv);
          await updateMtaStsMxHosts(env.DB, id, mxHosts.join(','), newPolicyId);
          logAudit(env.DB, {
            customer_id: customerId,
            actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
            action: 'mta_sts.mx_refresh',
            resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
            before_value: { mx_hosts: oldMxHosts, policy_id: config.policy_id },
            after_value: { mx_hosts: mxHosts, policy_id: newPolicyId },
          }, ctx);
          return json({ ok: true, mx_hosts: mxHosts, policy_id: newPolicyId });
        }

        return err('nothing to update', 400);
      }

      if (method === 'DELETE') {
        // Disable + remove DNS records
        const config = await getMtaStsConfig(env.DB, id);
        if (!config) return new Response(null, { status: 204 });

        if (env.CLOUDFLARE_API_TOKEN && getZoneId()) {
          try {
            await deprovisionMtaSts(
              { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN },
              {
                mta_sts_record_id: config.mta_sts_record_id ?? null,
                tls_rpt_record_id: config.tls_rpt_record_id ?? null,
                cname_record_id: config.cname_record_id ?? null,
              }
            );
          } catch (e) {
            console.warn(`[mta-sts] deprovision DNS failed for ${domain.domain}:`, e);
          }
        }

        logAudit(env.DB, {
          customer_id: customerId,
          actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
          action: 'mta_sts.disable',
          resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
          before_value: { mode: config.mode, mx_hosts: config.mx_hosts?.split(',').filter(Boolean) ?? [], policy_id: config.policy_id },
        }, ctx);
        // Log each DNS record deleted
        const rd = reportsDomain(env);
        if (config.mta_sts_record_id) logAudit(env.DB, { customer_id: customerId, actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.delete', resource_type: 'dns_record', resource_id: config.mta_sts_record_id, resource_name: `_mta-sts.${domain.domain}`, before_value: { type: 'TXT', name: `_mta-sts.${domain.domain}`, content: `v=STSv1; id=${config.policy_id}` } }, ctx);
        if (config.tls_rpt_record_id && rd) logAudit(env.DB, { customer_id: customerId, actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.delete', resource_type: 'dns_record', resource_id: config.tls_rpt_record_id, resource_name: `_smtp._tls.${domain.domain}`, before_value: { type: 'TXT', name: `_smtp._tls.${domain.domain}`, content: `v=TLSRPTv1; rua=mailto:tls-rpt@${rd}` } }, ctx);
        if (config.cname_record_id) logAudit(env.DB, { customer_id: customerId, actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.delete', resource_type: 'dns_record', resource_id: config.cname_record_id, resource_name: `mta-sts.${domain.domain}`, before_value: { type: 'CNAME', name: `mta-sts.${domain.domain}` } }, ctx);
        track(env, { event: 'mta_sts.disable' }); // fire-and-forget
        await deleteMtaStsConfig(env.DB, id);
        return new Response(null, { status: 204 });
      }
    }

    // MTA-STS policy file endpoint — GET /api/domains/:id/mta-sts/policy
    const mtaStsPolicyMatch = path.match(/^\/api\/domains\/([^/]+)\/mta-sts\/policy$/);
    if (mtaStsPolicyMatch && method === 'GET') {
      const id = parseInt(mtaStsPolicyMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const config = await getMtaStsConfig(env.DB, id);
      if (!config?.enabled) return err('MTA-STS not enabled', 404);
      const mxHosts = config.mx_hosts ? config.mx_hosts.split(',').filter(Boolean) : [];
      const policy = buildPolicyFile(config.mode, mxHosts, 86400);
      return new Response(policy, { headers: { 'Content-Type': 'text/plain' } });
    }

    // GET /api/audit-log — admin only
    if (path === '/api/audit-log' && method === 'GET') {
      const actor = await getUserBySession(env.DB, requestKey);
      if (!actor || actor.role !== 'admin') return err('admin required', 403);
      const page  = parseInt(url.searchParams.get('page')  ?? '1',  10);
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const { results } = await getAuditLog(env.DB, customerId, {
        page:      isNaN(page)  ? 1  : page,
        limit:     isNaN(limit) ? 50 : limit,
        action:    url.searchParams.get('action')    ?? undefined,
        domain_id: url.searchParams.get('domain_id') ?? undefined,
        actor_id:  url.searchParams.get('actor_id')  ?? undefined,
        since:     url.searchParams.get('since')  ? parseInt(url.searchParams.get('since')!, 10)  : undefined,
        until:     url.searchParams.get('until')  ? parseInt(url.searchParams.get('until')!, 10)  : undefined,
      });
      return json({ entries: results, page, limit });
    }

    return err('not found', 404);
  } catch (e: any) {
    if (e?.status && e?.message) return err(e.message, e.status);
    console.error('API error', e);
    return err('internal server error', 500);
  }
}
