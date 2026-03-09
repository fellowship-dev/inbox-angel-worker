import { Env } from './index';

export function reportsDomain(env: Pick<Env, 'REPORTS_DOMAIN' | 'BASE_DOMAIN'>): string | undefined {
  return env.REPORTS_DOMAIN ?? (env.BASE_DOMAIN ? `reports.${env.BASE_DOMAIN}` : undefined);
}

export function fromEmail(env: Pick<Env, 'FROM_EMAIL' | 'BASE_DOMAIN'>): string | undefined {
  return env.FROM_EMAIL ?? (env.BASE_DOMAIN ? `noreply@reports.${env.BASE_DOMAIN}` : undefined);
}
