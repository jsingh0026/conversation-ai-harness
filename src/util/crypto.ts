import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated symmetric encryption for secrets at rest (e.g. the HighLevel
 * refresh token before it's written to Postgres). AES-256-GCM; the key lives in
 * a deploy secret (never in the DB), so a database leak yields only ciphertext.
 *
 * Wire format: `v1:<iv b64>:<tag b64>:<ciphertext b64>` — versioned so the
 * scheme can evolve, and self-identifying so decrypt() can pass through values
 * that were never encrypted (e.g. rows written before a key was configured).
 */
const PREFIX = 'v1';

/** Parse a 32-byte key from a 64-char hex string (e.g. `openssl rand -hex 32`). */
function toKey(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('encryption key must be 32 bytes (64 hex chars)');
  }
  return key;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(`${PREFIX}:`);
}

export function encryptSecret(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', toKey(keyHex), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(payload: string, keyHex: string): string {
  if (!isEncrypted(payload)) return payload; // plaintext (pre-encryption) — pass through
  const [, ivB64, tagB64, ctB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', toKey(keyHex), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
