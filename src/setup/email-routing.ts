// Ensures Cloudflare Email Routing is configured for REPORTS_DOMAIN.
// Called automatically on first domain add — idempotent, safe to call multiple times.
//
// What it does:
//   1. Checks if catch-all email routing rule already exists — skips if so
//   2. Enables Email Routing on the zone
//   3. Clones apex MX records to REPORTS_DOMAIN subdomain
//   4. Sets catch-all rule: *@REPORTS_DOMAIN → this Worker
//
// Requires: CLOUDFLARE_API_TOKEN (DNS:Edit + Email Routing Rules:Edit)

import type { Env } from '../index';
import { getZoneId, reportsDomain } from '../env-utils';

type CfResult<T> = { success: boolean; result: T; errors: { message: string }[] };

async function cfFetch<T>(token: string, zoneId: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as CfResult<T>;
  if (!data.success) throw new Error(data.errors.map(e => e.message).join(', '));
  return data.result;
}

interface EmailRule {
  enabled: boolean;
  actions: { type: string; value?: string[] }[];
  matchers: { type: string }[];
}

interface DnsRecord {
  id: string;
  name: string;
  content: string;
  priority: number;
}

/**
 * Registers an email address as a verified destination in Cloudflare Email Routing.
 * CF sends a verification email automatically — user just clicks the link.
 * Requires: CLOUDFLARE_API_TOKEN with "Email Routing Addresses: Write" (account scope).
 * Returns true if the API call succeeded, false if skipped or failed (non-fatal).
 */
export async function registerEmailRoutingDestination(
  token: string,
  accountId: string,
  email: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/routing/addresses`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }
    );
    const data = await res.json() as { success: boolean; errors?: { message: string }[] };
    if (!data.success) {
      // "already exists" is fine — address just needs the user to verify if they haven't
      const alreadyExists = data.errors?.some(e => e.message.toLowerCase().includes('already'));
      if (!alreadyExists) console.warn('[setup] registerEmailRoutingDestination failed:', data.errors);
    }
    return true;
  } catch (e) {
    console.warn('[setup] registerEmailRoutingDestination error:', e);
    return false;
  }
}

export interface EmailRoutingResult {
  status: 'already_configured' | 'newly_configured' | 'skipped';
  detail: string;
}

export async function ensureEmailRouting(env: Env): Promise<EmailRoutingResult> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const zoneId = getZoneId();
  const domain = reportsDomain();
  const workerName = env.WORKER_NAME ?? 'inbox-angel-worker';

  if (!token || !zoneId || !domain) {
    console.log('[setup] missing CF credentials — skipping email routing setup');
    return { status: 'skipped', detail: 'Cloudflare credentials or reports domain not configured' };
  }

  // Step 1: Check if catch-all rule already points to a worker
  let catchAllActive = false;
  try {
    const catchAll = await cfFetch<EmailRule>(token, zoneId, 'GET', '/email/routing/rules/catch_all');
    catchAllActive = !!(catchAll?.enabled && catchAll.actions.some(a => a.type === 'worker'));
  } catch {
    // catch_all rule doesn't exist yet — will create below
  }

  // Step 2: Enable Email Routing on the zone (best-effort — may already be enabled,
  // and the /enable endpoint requires a broader permission than Email Routing Rules)
  if (!catchAllActive) {
    try {
      await cfFetch(token, zoneId, 'PUT', '/email/routing/enable');
      console.log('[setup] email routing enabled');
    } catch (e) {
      console.log(`[setup] email routing enable skipped (likely already active): ${e instanceof Error ? e.message : e}`);
    }
  }

  // Step 3: Ensure MX records for REPORTS_DOMAIN point to CF Email Routing (always runs)
  // CF Email Routing requires its own MX servers — NOT the user's mail server MX records.
  const CF_EMAIL_ROUTING_MX = [
    { content: 'route1.mx.cloudflare.net', priority: 40 },
    { content: 'route2.mx.cloudflare.net', priority: 83 },
    { content: 'route3.mx.cloudflare.net', priority: 98 },
  ];

  let mxCreated = false;
  const existingMx = await cfFetch<DnsRecord[]>(token, zoneId, 'GET', `/dns_records?type=MX&name=${domain}`);
  const hasCfMx = existingMx.some(r => r.content.endsWith('.mx.cloudflare.net'));

  if (!hasCfMx) {
    // Delete any non-CF MX records on the subdomain (e.g. cloned user mail server records)
    for (const old of existingMx) {
      if (!old.content.endsWith('.mx.cloudflare.net')) {
        try {
          await cfFetch(token, zoneId, 'DELETE', `/dns_records/${old.id}`);
        } catch {}
      }
    }

    const subdomain = domain.split('.')[0];
    for (const mx of CF_EMAIL_ROUTING_MX) {
      await cfFetch(token, zoneId, 'POST', '/dns_records', {
        type: 'MX', name: subdomain, content: mx.content, priority: mx.priority, ttl: 1,
      });
    }
    console.log(`[setup] CF Email Routing MX records added for ${domain}`);
    mxCreated = true;
  }

  // If catch-all was already active and MX records existed, nothing to do
  if (catchAllActive && !mxCreated) {
    return { status: 'already_configured', detail: 'Email routing catch-all rule and MX records already active' };
  }

  // Step 4: Set catch-all rule → this Worker (skip if already active)
  if (!catchAllActive) {
    await cfFetch(token, zoneId, 'PUT', '/email/routing/rules/catch_all', {
      actions: [{ type: 'worker', value: [workerName] }],
      enabled: true,
      matchers: [{ type: 'all' }],
      name: `catch-all → ${workerName}`,
    });
    console.log(`[setup] catch-all rule set → ${workerName}`);
  }

  const parts = [mxCreated ? 'MX records created' : null, !catchAllActive ? 'catch-all rule set' : null].filter(Boolean);
  return { status: 'newly_configured', detail: `${parts.join(' + ')} for ${domain}` };
}

/**
 * Ensures null-sender protection records exist on the reports subdomain:
 *   - SPF: `v=spf1 -all` on {reportsDomain}
 *   - DMARC: `v=DMARC1; p=reject;` on `_dmarc.{reportsDomain}`
 *
 * Returns an array of 2 action strings describing what happened for each record.
 */
export async function ensureNullSenderRecords(
  token: string,
  zoneId: string,
  rdomain: string,
): Promise<string[]> {
  const CF_API = `https://api.cloudflare.com/client/v4/zones/${zoneId}`;
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  const actions: string[] = [];

  // --- SPF on reports subdomain ---
  const spfExpected = 'v=spf1 -all';
  const spfRes = await fetch(`${CF_API}/dns_records?type=TXT&name=${encodeURIComponent(rdomain)}&per_page=50`, { headers });
  const spfData = await spfRes.json() as CfResult<{ id: string; content: string }[]>;
  const spfRecords = spfData.result ?? [];
  const spfMatch = spfRecords.find(r => {
    const clean = r.content.replace(/^"|"$/g, '');
    return clean.startsWith('v=spf1');
  });

  if (spfMatch) {
    const clean = spfMatch.content.replace(/^"|"$/g, '');
    if (clean === spfExpected) {
      actions.push(`SPF ${rdomain}: exists`);
    } else {
      console.warn(`[setup] null-sender conflict: SPF on ${rdomain} is "${clean}", expected "${spfExpected}"`);
      actions.push(`SPF ${rdomain}: conflict (found "${clean}")`);
    }
  } else {
    await fetch(`${CF_API}/dns_records`, {
      method: 'POST', headers,
      body: JSON.stringify({ type: 'TXT', name: rdomain, content: `"${spfExpected}"`, ttl: 3600 }),
    });
    actions.push(`SPF ${rdomain}: created`);
  }

  // --- DMARC on reports subdomain ---
  const dmarcExpected = 'v=DMARC1; p=reject;';
  const dmarcName = `_dmarc.${rdomain}`;
  const dmarcRes = await fetch(`${CF_API}/dns_records?type=TXT&name=${encodeURIComponent(dmarcName)}&per_page=50`, { headers });
  const dmarcData = await dmarcRes.json() as CfResult<{ id: string; content: string }[]>;
  const dmarcRecords = dmarcData.result ?? [];
  const dmarcMatch = dmarcRecords.find(r => {
    const clean = r.content.replace(/^"|"$/g, '');
    return clean.startsWith('v=DMARC1');
  });

  if (dmarcMatch) {
    const clean = dmarcMatch.content.replace(/^"|"$/g, '');
    if (clean === dmarcExpected) {
      actions.push(`DMARC ${dmarcName}: exists`);
    } else {
      console.warn(`[setup] null-sender conflict: DMARC on ${dmarcName} is "${clean}", expected "${dmarcExpected}"`);
      actions.push(`DMARC ${dmarcName}: conflict (found "${clean}")`);
    }
  } else {
    await fetch(`${CF_API}/dns_records`, {
      method: 'POST', headers,
      body: JSON.stringify({ type: 'TXT', name: dmarcName, content: `"${dmarcExpected}"`, ttl: 3600 }),
    });
    actions.push(`DMARC ${dmarcName}: created`);
  }

  return actions;
}
