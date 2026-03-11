// Cloudflare DNS provisioning for DMARC authorization records.
//
// RFC 7489 §7.1: when the rua= address is on a different domain than the
// policy domain, the reporting domain MUST publish a DNS TXT record to
// authorize receipt of reports:
//
//   {policy-domain}._report._dmarc.{reports-domain}  TXT  "v=DMARC1;"
//
// Example: adding acme.com, reports domain is reports.inboxangel.io
//   → create: acme.com._report._dmarc.reports.inboxangel.io  TXT  "v=DMARC1;"
//
// We manage this record via Cloudflare DNS API. The CF record ID is stored in
// domains.dns_record_id so we can delete it when the domain is removed.

import { getZoneId } from '../env-utils';
import { logAudit } from '../audit/log';

const CF_API = 'https://api.cloudflare.com/client/v4';

/** Optional audit context — pass to enable self-logging of DNS mutations. */
export interface DnsAuditOpts {
  db: D1Database;
  actor_id?: string | null;
  actor_email?: string | null;
  actor_type?: 'user' | 'system';
  ctx?: ExecutionContext;
}

export class DnsProvisionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DnsProvisionError';
  }
}

export interface DnsProvisionResult {
  recordId: string | null;  // Cloudflare DNS record ID (null in manual mode)
  recordName: string;       // Full DNS name that was created
  manual: boolean;          // true = CF creds absent, user must add DNS record manually
}

interface ProvisionEnv {
  CLOUDFLARE_API_TOKEN: string;
  REPORTS_DOMAIN: string;  // e.g. "reports.inboxangel.io"
}

interface DeprovisionEnv {
  CLOUDFLARE_API_TOKEN: string;
}

function cfHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Creates the cross-domain DMARC authorization TXT record for a monitored domain.
 * Call this when a domain is added.
 */
export async function provisionDomain(
  env: ProvisionEnv,
  policyDomain: string,
  audit?: DnsAuditOpts,
): Promise<DnsProvisionResult> {
  // RFC 7489 §7.1 cross-domain authorization record name
  const recordName = `${policyDomain}._report._dmarc.${env.REPORTS_DOMAIN}`;
  const zoneId = getZoneId();

  if (!env.CLOUDFLARE_API_TOKEN || !zoneId) {
    // Manual mode — caller must add the DNS record themselves
    return { recordId: null, recordName, manual: true };
  }

  const body = {
    type: 'TXT',
    name: recordName,
    content: 'v=DMARC1;',
    ttl: 3600,
    comment: `InboxAngel DMARC auth for ${policyDomain}`,
  };

  let res: Response;
  try {
    res = await fetch(`${CF_API}/zones/${zoneId}/dns_records`, {
      method: 'POST',
      headers: cfHeaders(env.CLOUDFLARE_API_TOKEN),
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new DnsProvisionError(`DNS provision fetch failed: ${String(e)}`, e);
  }

  const data = await res.json() as { success: boolean; result?: { id: string }; errors?: { message: string }[] };

  if (!data.success || !data.result?.id) {
    const msg = data.errors?.map(e => e.message).join(', ') ?? 'unknown error';
    throw new DnsProvisionError(`Cloudflare rejected DNS record creation: ${msg}`);
  }

  if (audit) {
    logAudit(audit.db, {
      actor_id: audit.actor_id,
      actor_email: audit.actor_email,
      actor_type: audit.actor_type ?? 'user',
      action: 'dns.create',
      resource_type: 'dns_record',
      resource_id: data.result.id,
      resource_name: recordName,
      after_value: { type: 'TXT', name: recordName, content: 'v=DMARC1;', ttl: 3600 },
    }, audit.ctx);
  }

  return { recordId: data.result.id, recordName, manual: false };
}

/**
 * Deletes the cross-domain DMARC authorization record.
 * Call this when a domain is removed. Idempotent — 404 is silently ignored.
 */
export async function deprovisionDomain(
  env: DeprovisionEnv,
  recordId: string,
  audit?: DnsAuditOpts,
): Promise<void> {
  const zoneId = getZoneId();

  if (!env.CLOUDFLARE_API_TOKEN || !zoneId) {
    // If CF creds aren't configured, there's nothing to clean up
    return;
  }

  let res: Response;
  try {
    res = await fetch(`${CF_API}/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'DELETE',
      headers: cfHeaders(env.CLOUDFLARE_API_TOKEN),
    });
  } catch (e) {
    // Network failure — log but don't throw; domain delete should still succeed
    console.warn(`deprovisionDomain: fetch failed for record ${recordId}:`, e);
    return;
  }

  // 404 = already gone (idempotent)
  if (!res.ok && res.status !== 404) {
    console.warn(`deprovisionDomain: unexpected status ${res.status} for record ${recordId}`);
  }

  if (audit && (res.ok || res.status === 404)) {
    logAudit(audit.db, {
      actor_id: audit.actor_id,
      actor_email: audit.actor_email,
      actor_type: audit.actor_type ?? 'user',
      action: 'dns.delete',
      resource_type: 'dns_record',
      resource_id: recordId,
      before_value: { record_id: recordId },
    }, audit.ctx);
  }
}
