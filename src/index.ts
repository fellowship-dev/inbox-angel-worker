import { handleEmail } from './email/handler';
import { handleApi } from './api/router';
import { getActiveSubscriptions, updateSubscriptionBaseline } from './db/queries';
import { checkSubscription } from './monitor/check';
import { sendChangeNotification } from './monitor/notify';

export interface Env {
  DB: D1Database;
  AUTH0_DOMAIN: string;        // empty = bypass mode (use X-Api-Key)
  AUTH0_AUDIENCE: string;
  AUTH0_ORG_CLAIM?: string;    // JWT claim for customer ID, default "org_id"
  API_KEY?: string;            // bypass-mode API key (wrangler secret)
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_ZONE_ID: string;
  CLOUDFLARE_API_TOKEN: string; // secret
  REPORTS_DOMAIN: string;       // e.g. "reports.inboxangel.io" — REQUIRED, no default
  CHECK_PREFIX?: string;        // free-check address prefix, default "check-" (self-hosters can rename)
  FROM_EMAIL: string;
  RESEND_API_KEY?: string;      // transactional email for monitor alerts (optional — logs if unset)
}

// HTTP API (dashboard calls, DNS provisioning)
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleApi(request, env, ctx);
  },

  // Email Worker (inbound: free check + DMARC RUA reports)
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleEmail(message, env, ctx);
  },

  // Daily cron — re-check DNS for all active monitor subscriptions
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
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
