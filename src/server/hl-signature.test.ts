import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyHighLevelSignature } from './hl-signature.js';

// Stand-in for HighLevel's key: an Ed25519 pair we control in the test.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signBody = (body: string) => sign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64');

describe('verifyHighLevelSignature (Ed25519)', () => {
  const body = '{"type":"InboundMessage","contactId":"c1","body":"hi"}';

  it('accepts a valid signature over the raw body', () => {
    const headers = { 'x-ghl-signature': signBody(body) };
    expect(verifyHighLevelSignature(body, headers, pubPem)).toBe(true);
  });

  it('rejects when the body was tampered with', () => {
    const headers = { 'x-ghl-signature': signBody(body) };
    expect(verifyHighLevelSignature(body + ' ', headers, pubPem)).toBe(false);
  });

  it('rejects a missing / N/A signature header', () => {
    expect(verifyHighLevelSignature(body, {}, pubPem)).toBe(false);
    expect(verifyHighLevelSignature(body, { 'x-ghl-signature': 'N/A' }, pubPem)).toBe(false);
  });

  it('rejects garbage in the signature header without throwing', () => {
    expect(verifyHighLevelSignature(body, { 'x-ghl-signature': 'not-base64-!!!' }, pubPem)).toBe(false);
  });
});
