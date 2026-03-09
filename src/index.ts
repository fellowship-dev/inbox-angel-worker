import { handleEmail } from './email/handler';
import { handleApi } from './api/router';
import { getActiveSubscriptions, updateSubscriptionBaseline } from './db/queries';
import { checkSubscription } from './monitor/check';
import { sendChangeNotification } from './monitor/notify';
import { sendWeeklyDigests } from './digest/weekly';
import { ensureMigrated } from './db/migrate';

export interface Env {
  DB: D1Database | undefined;
  ASSETS: Fetcher;
  AUTH0_DOMAIN: string;         // empty = bypass mode (use X-Api-Key)
  AUTH0_AUDIENCE: string;
  AUTH0_ORG_CLAIM?: string;     // JWT claim for customer ID, default "org_id"
  API_KEY?: string;             // bypass-mode API key (wrangler secret)
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_API_TOKEN?: string; // secret — optional; omit to provision DNS manually
  WORKER_NAME?: string;          // defaults to "inbox-angel-worker"; used for email routing catch-all rule
  TELEMETRY_ENABLED?: string;    // "true" to send anonymous usage events to InboxAngel (default: off)
  DEBUG?: string;                // "true" to enable verbose logging to Cloudflare Workers Logs (default: off)
  SEND_EMAIL?: SendEmail;        // CF Email Workers outbound binding — logs if unset (wrangler dev has no local support)
  REPORTS_DOMAIN: string;        // e.g. "reports.inboxangel.io" — REQUIRED, no default
  FROM_EMAIL: string;
  // Self-hosted single-tenant init — set these before first deploy; auto-provisions on first request
  CUSTOMER_DOMAIN?: string;      // e.g. "yourdomain.com"
  CUSTOMER_EMAIL?: string;       // alert and report recipient
  CUSTOMER_NAME?: string;        // display name (defaults to "Self-hosted")
}

// HTTP API (dashboard calls, DNS provisioning)
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.DB) return setupPage();
    await ensureMigrated(env.DB);
    const { pathname } = new URL(request.url);
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
    // Weekly digest — every Monday 9am UTC
    if (event.cron === '0 9 * * 1') {
      await sendWeeklyDigests(env);
      return;
    }

    // Daily monitor check — every day 8am UTC (default / catch-all)
    const { results: subscriptions } = await getActiveSubscriptions(env.DB, 200);
    console.log(`[monitor] checking ${subscriptions.length} subscriptions`);

    for (const sub of subscriptions) {
      try {
        const { changes, newBaseline } = await checkSubscription(sub);
        await updateSubscriptionBaseline(env.DB, sub.id, newBaseline);

        if (changes.length > 0) {
          console.log(`[monitor] ${sub.domain} changed: ${changes.map(c => c.field).join(', ')}`);
          await sendChangeNotification(sub.email, sub.domain, changes, env);
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
    <li>Set your secrets:<br><pre>wrangler secret put CLOUDFLARE_API_TOKEN
wrangler secret put REPORTS_DOMAIN
wrangler secret put FROM_EMAIL
wrangler secret put CUSTOMER_DOMAIN
wrangler secret put CUSTOMER_EMAIL
wrangler secret put CUSTOMER_NAME</pre>
      <small>No <code>API_KEY</code> needed — you'll create your login on first visit to the dashboard.</small>
    </li>
  </ol>
  <div class="note">
    Full setup guide: <a href="https://github.com/Fellowship-dev/inbox-angel-worker#self-hosting" target="_blank">github.com/Fellowship-dev/inbox-angel-worker</a>
  </div>
</body>
</html>`;
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
