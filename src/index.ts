import { handleEmail } from './email/handler';
import { handleApi } from './api/router';

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
} satisfies ExportedHandler<Env>;
