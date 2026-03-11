import { handleEmail } from './email/handler';
import { handleApi } from './api/router';
import { getActiveSubscriptions, updateSubscriptionBaseline, getAllEnabledSpfFlattenConfigs, updateSpfFlattenResult, updateSpfFlattenError, getDomainById, getAllDomains, updateDomainSpfLookupCount, getAllEnabledMtaStsConfigs, getMtaStsConfigByDomain, updateMtaStsMxHosts, updateMtaStsError, getHeartbeatStats } from './db/queries';
import { checkSubscription } from './monitor/check';
import { sendChangeNotification } from './monitor/notify';
import { sendWeeklyDigests } from './digest/weekly';
import { ensureMigrated } from './db/migrate';
import { reportsDomain, fromEmail, enrichEnv, getZoneId } from './env-utils';
import { logAudit } from './audit/log';
import { track } from './telemetry';
import { flattenSpf } from './email/spf-flattener';
import { lookupSpf } from './email/dns-check';
import { discoverMxHosts, generatePolicyId, buildPolicyFile, updateMtaStsTxtRecord } from './email/mta-sts';

export interface Env {
  DB: D1Database | undefined;
  ASSETS: Fetcher;
  // Auth (legacy JWT — leave empty to use email/password dashboard auth)
  AUTH0_DOMAIN?: string;
  AUTH0_AUDIENCE?: string;
  AUTH0_ORG_CLAIM?: string;
  API_KEY?: string;             // legacy bypass key — superseded by email/password auth
  // Cloudflare (secrets — set via wrangler secret put)
  CLOUDFLARE_API_TOKEN?: string; // EMAIL token: email routing + DNS writes
  // Worker config (vars in wrangler.jsonc)
  WORKER_NAME?: string;          // defaults to "inbox-angel-worker"
  // Bindings
  SEND_EMAIL?: SendEmail;        // CF Email Workers outbound binding
  AUTH_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> }; // auth rate limiting (10/min)
  API_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };  // global rate limiting (200/min)
  // Domain config — set via wizard (D1) or env var override
  BASE_DOMAIN?: string;          // e.g. "yourdomain.com" — resolved from D1 when absent
  REPORTS_DOMAIN?: string;       // defaults to "reports.<BASE_DOMAIN>"
  FROM_EMAIL?: string;           // defaults to "noreply@reports.<BASE_DOMAIN>"
}

// HTTP API (dashboard calls, DNS provisioning)
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.DB) return setupPage();
    await ensureMigrated(env.DB);
    const url = new URL(request.url);
    const { pathname, hostname } = url;

    // MTA-STS policy file — served on mta-sts.* hostnames per RFC 8461
    // mta-sts.domain.com CNAME → this Worker; CF Universal SSL covers HTTPS
    if (hostname.startsWith('mta-sts.') && pathname === '/.well-known/mta-sts.txt') {
      const domain = hostname.slice('mta-sts.'.length);
      const config = await getMtaStsConfigByDomain(env.DB, domain);
      if (!config) return new Response('MTA-STS not configured for this domain', { status: 404 });
      const mxHosts = config.mx_hosts ? config.mx_hosts.split(',').filter(Boolean) : [];
      const policy = buildPolicyFile(config.mode, mxHosts, 86400);
      return new Response(policy, {
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'max-age=300',
        },
      });
    }

    if (pathname === '/health' || pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  // Email Worker (inbound: free check + DMARC RUA reports)
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.DB) { console.error('[email] DB binding missing — D1 not configured'); return; }
    await ensureMigrated(env.DB);
    await handleEmail(message, env, ctx);
  },

  // Cron dispatcher — routes by schedule expression
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.DB) { console.error('[cron] DB binding missing — D1 not configured'); return; }
    await ensureMigrated(env.DB);
    env = await enrichEnv(env, env.DB);
    const rd = reportsDomain(env) ?? '';
    const fe = fromEmail(env) ?? '';
    const derivedEnv = { ...env, REPORTS_DOMAIN: rd, FROM_EMAIL: fe };

    // Daily telemetry heartbeat — every day 11am UTC
    if (event.cron === '0 11 * * *') {
      try {
        const stats = await getHeartbeatStats(env.DB!);
        await track(env, { event: 'instance.heartbeat', ...stats });
      } catch (e) {
        console.error('[telemetry] heartbeat failed:', e);
      }
      return;
    }

    // Weekly digest — every Monday 9am UTC
    if (event.cron === '0 9 * * 1') {
      await sendWeeklyDigests(derivedEnv);
      return;
    }

    // Daily SPF flatten refresh — every day 10am UTC
    if (event.cron === '0 10 * * *') {
      if (env.CLOUDFLARE_API_TOKEN && getZoneId()) {
        const { results: configs } = await getAllEnabledSpfFlattenConfigs(env.DB);
        console.log(`[spf-flatten] refreshing ${configs.length} flattened domains`);
        for (const config of configs) {
          const domain = await getDomainById(env.DB, config.domain_id);
          if (!domain) continue;
          try {
            const result = await flattenSpf(domain.domain, {
              CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
            }, config.cf_record_id);
            await updateSpfFlattenResult(env.DB, config.domain_id, result.flattened_record, result.ip_count, result.cf_record_id);
            console.log(`[spf-flatten] ${domain.domain}: updated (${result.ip_count} IPs)`);
            logAudit(env.DB, {
              actor_type: 'system',
              action: 'spf_flatten.update',
              resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
              before_value: { spf_record: config.flattened_record ?? config.canonical_record },
              after_value: { spf_record: result.flattened_record, ip_count: result.ip_count },
              meta: { cron: '0 10 * * *' },
            }, ctx);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await updateSpfFlattenError(env.DB, config.domain_id, msg);
            console.error(`[spf-flatten] ${domain.domain}: error — ${msg}`);
          }
        }
      }
      return;
    }

    // Daily monitor check — every day 8am UTC (default / catch-all)
    // Also refresh SPF lookup counts for all domains
    const { results: allDomains } = await getAllDomains(env.DB);
    for (const d of allDomains) {
      lookupSpf(d.domain)
        .then(spf => {
          if (spf?.lookup_count !== undefined) {
            return updateDomainSpfLookupCount(env.DB!, d.id, spf.lookup_count);
          }
        })
        .catch(e => console.warn(`[monitor] SPF lookup refresh failed for ${d.domain}:`, e));
    }

    // MTA-STS MX refresh — update policy_id in DNS if MX hosts changed
    if (env.CLOUDFLARE_API_TOKEN && getZoneId()) {
      const { results: mtaConfigs } = await getAllEnabledMtaStsConfigs(env.DB);
      const patchEnv = { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN };
      for (const cfg of mtaConfigs) {
        const domain = await getDomainById(env.DB, cfg.domain_id);
        if (!domain) continue;
        try {
          const liveMx = await discoverMxHosts(domain.domain);
          const storedMx = cfg.mx_hosts ? cfg.mx_hosts.split(',').filter(Boolean) : [];
          const changed = liveMx.length !== storedMx.length || liveMx.some((h, i) => h !== storedMx[i]);
          if (changed && cfg.mta_sts_record_id) {
            const newPolicyId = generatePolicyId();
            await updateMtaStsTxtRecord(cfg.mta_sts_record_id, newPolicyId, patchEnv);
            await updateMtaStsMxHosts(env.DB, cfg.domain_id, liveMx.join(','), newPolicyId);
            console.log(`[mta-sts] ${domain.domain}: MX changed, policy_id updated`);
            logAudit(env.DB, {
              actor_type: 'system',
              action: 'cron.mta_sts_mx',
              resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
              before_value: { mx_hosts: storedMx, policy_id: cfg.policy_id },
              after_value: { mx_hosts: liveMx, policy_id: newPolicyId },
              meta: { cron: '0 8 * * *' },
            }, ctx);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await updateMtaStsError(env.DB, cfg.domain_id, msg);
          console.error(`[mta-sts] ${domain.domain}: MX refresh error — ${msg}`);
        }
      }
    }

    const { results: subscriptions } = await getActiveSubscriptions(env.DB, 200);
    console.log(`[monitor] checking ${subscriptions.length} subscriptions`);

    for (const sub of subscriptions) {
      try {
        const { changes, newBaseline } = await checkSubscription(sub);
        await updateSubscriptionBaseline(env.DB, sub.id, newBaseline);

        if (changes.length > 0) {
          console.log(`[monitor] ${sub.domain} changed: ${changes.map(c => c.field).join(', ')}`);
          await sendChangeNotification(sub.email, sub.domain, changes, derivedEnv);
        }
      } catch (e) {
        console.error(`[monitor] error checking ${sub.domain}:`, e);
      }
    }
  },
} satisfies ExportedHandler<Env>;

function setupPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>InboxAngel — Setup Required</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 80px auto; padding: 0 24px; color: #1a1a1a; }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    .badge { display: inline-block; background: #fef3c7; color: #92400e; font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 4px; margin-bottom: 24px; }
    ol { padding-left: 1.25rem; line-height: 2; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    pre { background: #f3f4f6; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; line-height: 1.6; }
    a { color: #4f46e5; }
    .note { background: #eff6ff; border-left: 3px solid #3b82f6; padding: 12px 16px; border-radius: 0 8px 8px 0; font-size: 0.9rem; margin-top: 24px; }
  </style>
</head>
<body>
  <h1>🪄 InboxAngel</h1>
  <div class="badge">Setup required</div>
  <p>Your Worker is running, but no D1 database is attached yet. Complete these steps to finish setup:</p>
  <ol>
    <li>Create a D1 database:<br><pre>wrangler d1 create inbox-angel</pre></li>
    <li>Copy the <code>database_id</code> from the output and paste it into <code>wrangler.jsonc</code> under <code>d1_databases[0].database_id</code>.</li>
    <li>Set your API token:<br><pre>wrangler secret put CLOUDFLARE_API_TOKEN</pre>
      <small>This is the only secret you need. Your domain is configured in the setup wizard after first login.</small>
    </li>
    <li>Deploy:<br><pre>npm run deploy</pre>Then visit your dashboard, create an account, and enter your domain in the setup wizard.</li>
  </ol>
  <div class="note">
    Full setup guide: <a href="https://github.com/Fellowship-dev/inbox-angel-worker#self-hosting" target="_blank">github.com/Fellowship-dev/inbox-angel-worker</a>
  </div>
</body>
</html>`;
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
