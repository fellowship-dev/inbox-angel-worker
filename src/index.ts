import { handleEmail } from './email/handler';
import { handleApi } from './api/router';

export interface Env {
  DB: D1Database;
  AUTH0_DOMAIN: string;
  AUTH0_AUDIENCE: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_ZONE_ID: string;
  CLOUDFLARE_API_TOKEN: string; // secret
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
