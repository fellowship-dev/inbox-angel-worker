// REST API router for InboxAngel Worker.
// All /api/* routes require authentication via requireAuth().
// Auth provider is pluggable — see src/api/auth.ts.
//
// Routes:
//   GET  /health                          — liveness probe (unauthenticated)
//   POST /api/check-sessions              — create a free-check session (unauthenticated)
//   GET  /api/check-sessions/:token       — poll for free-check result (unauthenticated)
//   GET  /api/domains                     — list customer's monitored domains
//   POST /api/domains                     — add a domain
//   DELETE /api/domains/:id               — remove a domain
//   GET  /api/reports                     — list recent aggregate reports
//   GET  /api/reports/:id                 — single report with per-IP records
//   GET  /api/check-results               — recent free check results (last 20)

import { Env } from '../index';
import { requireAuth, AuthError } from './auth';
import {
  getDomainsByCustomer,
  getDomainById,
  insertDomain,
  updateDomainDnsRecord,
  getRecentReports,
  getCheckResultByToken,
} from '../db/queries';
import { provisionDomain, deprovisionDomain, DnsProvisionError } from '../dns/provision';

// ── Helpers ───────────────────────────────────────────────────

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

async function addDomain(request: Request, env: Env, customerId: string): Promise<Response> {
  const body = await parseBody<{ domain?: string }>(request);
  if (!body.domain || typeof body.domain !== 'string') {
    return err('domain is required', 400);
  }

  const domain = body.domain.toLowerCase().trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return err('invalid domain format', 400);
  }

  // RUA address derived from customer ID + domain slug (unique per domain)
  if (!env.REPORTS_DOMAIN) return err('REPORTS_DOMAIN is not configured', 500);
  const slug = domain.replace(/\./g, '-');
  const ruaAddress = `${customerId}-${slug}@${env.REPORTS_DOMAIN}`;

  // Provision the cross-domain DMARC authorization record first.
  // If CF fails we bail before touching the DB — no orphaned rows.
  let provision: { recordId: string; recordName: string } | null = null;
  try {
    provision = await provisionDomain(env, domain);
  } catch (e) {
    if (e instanceof DnsProvisionError) {
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
    // Rollback: clean up the DNS record we just created
    if (provision) await deprovisionDomain(env, provision.recordId).catch(() => {});
    if (e?.message?.includes('UNIQUE')) return err('domain already registered', 409);
    throw e;
  }

  // Record the CF DNS record ID for future cleanup
  await updateDomainDnsRecord(env.DB, domainId, provision.recordId).catch(e =>
    console.warn('updateDomainDnsRecord failed (non-fatal):', e)
  );

  return json({ domain, rua_address: ruaAddress, auth_record: provision.recordName }, 201);
}

async function deleteDomain(env: Env, customerId: string, domainId: string): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  // Verify ownership and fetch the DNS record ID in one query
  const domain = await getDomainById(env.DB, id);
  if (!domain || domain.customer_id !== customerId) return err('domain not found', 404);

  await env.DB.prepare('DELETE FROM domains WHERE id = ? AND customer_id = ?')
    .bind(id, customerId)
    .run();

  // Best-effort cleanup of the CF DNS record (non-fatal if it fails)
  if (domain.dns_record_id) {
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

// ── Main router ───────────────────────────────────────────────

export async function handleApi(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  // Unauthenticated routes
  if (path === '/health' && method === 'GET') {
    return json({ ok: true, ts: Date.now() });
  }

  // POST /api/check-sessions — generate a unique free-check email for a browser session
  if (path === '/api/check-sessions' && method === 'POST') {
    if (!env.REPORTS_DOMAIN) return err('REPORTS_DOMAIN is not configured', 500);
    const token = crypto.randomUUID();
    const checkPrefix = env.CHECK_PREFIX ?? 'check-';
    return json({ token, email: `${checkPrefix}${token}@${env.REPORTS_DOMAIN}` }, 201);
  }

  // GET /api/check-sessions/:token — poll until the check email has been processed
  const sessionMatch = path.match(/^\/api\/check-sessions\/([^/]+)$/);
  if (sessionMatch && method === 'GET') {
    const result = await getCheckResultByToken(env.DB, sessionMatch[1]);
    if (!result) return json({ status: 'pending' }, 202);
    return json({ status: 'done', result });
  }

  // All /api/* routes require auth
  if (!path.startsWith('/api/')) {
    return err('not found', 404);
  }

  let customerId: string;
  try {
    const ctx = await requireAuth(request, env);
    customerId = ctx.customerId;
  } catch (e) {
    if (e instanceof AuthError) return err(e.message, e.status);
    return err('authentication error', 401);
  }

  try {
    // GET /api/domains
    if (path === '/api/domains' && method === 'GET') {
      return await getDomains(env, customerId);
    }
    // POST /api/domains
    if (path === '/api/domains' && method === 'POST') {
      return await addDomain(request, env, customerId);
    }
    // DELETE /api/domains/:id
    const domainDeleteMatch = path.match(/^\/api\/domains\/([^/]+)$/);
    if (domainDeleteMatch && method === 'DELETE') {
      return await deleteDomain(env, customerId, domainDeleteMatch[1]);
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

    return err('not found', 404);
  } catch (e: any) {
    if (e?.status && e?.message) return err(e.message, e.status);
    console.error('API error', e);
    return err('internal server error', 500);
  }
}
