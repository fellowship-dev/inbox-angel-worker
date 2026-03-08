import { Env } from '../index';

// Stub — Step 4
export async function handleFreeCheck(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  // TODO: parse Authentication-Results headers, live DNS lookup, send report back
  console.log('free-check from:', message.from);
}
