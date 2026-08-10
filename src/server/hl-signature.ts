import { verify } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * HighLevel signs native app webhooks (e.g. InboundMessage) so the receiver can
 * trust they came from HighLevel — they do NOT carry our shared `x-webhook-secret`.
 *
 * Preferred scheme: Ed25519 over the raw JSON body, signature in `x-ghl-signature`
 * (base64). The public key is HighLevel's published webhook key. (The older
 * RSA-SHA256 `x-wh-signature` scheme is deprecated Sept 2026; we verify the
 * current one.)
 */
const GHL_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

/** True when `rawBody` carries a valid HighLevel Ed25519 signature. */
export function verifyHighLevelSignature(
  rawBody: string,
  headers: IncomingHttpHeaders,
  publicKeyPem: string = GHL_ED25519_PUBLIC_KEY,
): boolean {
  const sig = headers['x-ghl-signature'];
  if (typeof sig !== 'string' || sig.length === 0 || sig === 'N/A') return false;
  try {
    // Ed25519 uses a null algorithm in Node's one-shot verify.
    return verify(
      null,
      Buffer.from(rawBody, 'utf8'),
      publicKeyPem,
      Buffer.from(sig, 'base64'),
    );
  } catch {
    return false;
  }
}
