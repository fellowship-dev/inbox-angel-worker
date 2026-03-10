import { handleEmail } from './email/handler';
import { handleApi } from './api/router';
import { getActiveSubscriptions, updateSubscriptionBaseline, getAllEnabledSpfFlattenConfigs, updateSpfFlattenResult, updateSpfFlattenError, getDomainById, getAllDomains, updateDomainSpfLookupCount, getAllEnabledMtaStsConfigs, getMtaStsConfigByDomain, updateMtaStsMxHosts, updateMtaStsError } from './db/queries';
import { checkSubscription } from './monitor/check';
import { sendChangeNotification } from './monitor/notify';
import { sendWeeklyDigests } from './digest/weekly';
import { ensureMigrated } from './db/migrate';
import { reportsDomain, fromEmail, enrichEnv } from './env-utils';
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
  CLOUDFLARE_ZONE_ID?: string;   // your zone ID — required for DNS provisioning
  CLOUDFLARE_ACCOUNT_ID?: string; // optional — used for anonymous telemetry ID
  // Worker config (vars in wrangler.jsonc)
  WORKER_NAME?: string;          // defaults to "inbox-angel-worker"
  TELEMETRY_ENABLED?: string;    // "true" to send anonymous usage events (default: off)
  DEBUG?: string;                // "true" for verbose CF Workers Logs (default: off)
  // Bindings
  SEND_EMAIL?: SendEmail;        // CF Email Workers outbound binding
  // Self-hosted single-tenant init — auto-provisions on first request
  BASE_DOMAIN?: string;          // e.g. "yourdomain.com" — required
  // Optional overrides — derived from BASE_DOMAIN when not set
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
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.DB) { console.error('[cron] DB binding missing — D1 not configured'); return; }
    await ensureMigrated(env.DB);
    env = await enrichEnv(env);
    const rd = reportsDomain(env) ?? '';
    const fe = fromEmail(env) ?? '';
    const derivedEnv = { ...env, REPORTS_DOMAIN: rd, FROM_EMAIL: fe };

    // Weekly digest — every Monday 9am UTC
    if (event.cron === '0 9 * * 1') {
      await sendWeeklyDigests(derivedEnv);
      return;
    }

    // Daily SPF flatten refresh — every day 10am UTC
    if (event.cron === '0 10 * * *') {
      if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ZONE_ID) {
        const { results: configs } = await getAllEnabledSpfFlattenConfigs(env.DB);
        console.log(`[spf-flatten] refreshing ${configs.length} flattened domains`);
        for (const config of configs) {
          const domain = await getDomainById(env.DB, config.domain_id);
          if (!domain) continue;
          try {
            const result = await flattenSpf(domain.domain, {
              CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
              CLOUDFLARE_ZONE_ID: env.CLOUDFLARE_ZONE_ID,
            }, config.cf_record_id);
            await updateSpfFlattenResult(env.DB, config.domain_id, result.flattened_record, result.ip_count, result.cf_record_id);
            console.log(`[spf-flatten] ${domain.domain}: updated (${result.ip_count} IPs)`);
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
    if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ZONE_ID) {
      const { results: mtaConfigs } = await getAllEnabledMtaStsConfigs(env.DB);
      const patchEnv = { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID: env.CLOUDFLARE_ZONE_ID };
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
    <li>Redeploy:<br><pre>npm run deploy</pre>The first request after redeploy will auto-migrate the schema — no extra step needed.</li>
    <li>Set your two required secrets:<br><pre>wrangler secret put CLOUDFLARE_API_TOKEN
wrangler secret put BASE_DOMAIN</pre>
      <small>Everything else auto-derives — zone ID is looked up from BASE_DOMAIN, reports subdomain defaults to <code>reports.&lt;BASE_DOMAIN&gt;</code>. No <code>API_KEY</code> needed — you'll create your login on first visit to the dashboard.</small>
    </li>
  </ol>
  <div class="note">
    Full setup guide: <a href="https://github.com/Fellowship-dev/inbox-angel-worker#self-hosting" target="_blank">github.com/Fellowship-dev/inbox-angel-worker</a>
  </div>
</body>
</html>`;
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
