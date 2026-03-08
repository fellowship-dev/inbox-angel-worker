import { Env } from '../index';
import { handleFreeCheck } from './free-check';
import { handleDmarcReport } from './dmarc-report';

// Routes inbound email by recipient address:
//   check@reports.inboxangel.com         → free SPF/DKIM/DMARC check
//   <customerId>@reports.inboxangel.com  → DMARC RUA aggregate report
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const to = message.to.toLowerCase();
  const localPart = to.split('@')[0];

  if (localPart === 'check') {
    await handleFreeCheck(message, env);
  } else {
    // Any other address is treated as a customer RUA inbox
    await handleDmarcReport(message, env, localPart);
  }
}
