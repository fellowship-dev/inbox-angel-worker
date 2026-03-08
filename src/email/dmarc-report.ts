import { Env } from '../index';

// Stub — Step 5
export async function handleDmarcReport(
  message: ForwardableEmailMessage,
  env: Env,
  customerId: string
): Promise<void> {
  // TODO: extract XML attachment, run DMARC parser, store in D1
  console.log('dmarc-report for customer:', customerId);
}
