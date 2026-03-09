/**
 * Password hashing and verification using Web Crypto PBKDF2.
 * Zero dependencies — runs natively in Cloudflare Workers.
 */

const ITERATIONS = 100_000;
const KEY_LEN = 256; // bits
const HASH = 'SHA-256';

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const pairs = hex.match(/.{2}/g) ?? [];
  return new Uint8Array(pairs.map(h => parseInt(h, 16)));
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: HASH },
    key,
    KEY_LEN,
  );
}

/** Returns a `saltHex:hashHex` string suitable for storing in D1. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return `${toHex(salt.buffer)}:${toHex(hash)}`;
}

/** Constant-time comparison — returns true if password matches the stored hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, expectedHex] = stored.split(':');
  if (!saltHex || !expectedHex) return false;
  const hash = await pbkdf2(password, fromHex(saltHex));
  return toHex(hash) === expectedHex;
}
