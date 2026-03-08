import { Env } from '../index';

// Stub — Step 6
export async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // Health check (unauthenticated)
  if (url.pathname === '/health') {
    return Response.json({ ok: true });
  }

  // TODO: auth middleware (Auth0 JWT), then route to /reports, /domains, /customers
  return Response.json({ error: 'not implemented' }, { status: 501 });
}
