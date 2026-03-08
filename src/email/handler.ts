import { Env } from '../index';
import { handleFreeCheck } from './free-check';
import { handleDmarcReport } from './dmarc-report';

// Routes inbound email by recipient address local part:
//   check-{token}@reports.yourdomain.com  → free SPF/DKIM/DMARC check (session-based)
//   anything else                         → DMARC RUA aggregate report (routed by XML content)
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const to = message.to.toLowerCase();
  const localPart = to.split('@')[0];

  const checkPrefix = env.CHECK_PREFIX ?? 'check-';
  if (localPart.startsWith(checkPrefix)) {
    const token = localPart.slice(checkPrefix.length);
    await handleFreeCheck(message, env, token);
  } else {
    // RUA report — customer is resolved from the policy_domain in the XML
    await handleDmarcReport(message, env);
  }
}
