import { Env } from '../index';
import { handleFreeCheck } from './free-check';
import { handleDmarcReport } from './dmarc-report';

// Routes inbound email by recipient address:
//   check-{token}@reports.inboxangel.io  → free SPF/DKIM/DMARC check (session-based)
//   {customerId}-{slug}@reports.inboxangel.io → DMARC RUA aggregate report
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
    // Any other address is treated as a customer RUA inbox
    await handleDmarcReport(message, env, localPart);
  }
}
