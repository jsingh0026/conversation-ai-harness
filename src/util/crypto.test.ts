import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, isEncrypted } from './crypto.js';

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'; // 32 bytes

describe('crypto (AES-256-GCM secret-at-rest)', () => {
  it('round-trips a secret', () => {
    const ct = encryptSecret('refresh-token-xyz', KEY);
    expect(isEncrypted(ct)).toBe(true);
    expect(ct).not.toContain('refresh-token-xyz');
    expect(decryptSecret(ct, KEY)).toBe('refresh-token-xyz');
  });

  it('produces a fresh IV each call (ciphertext differs, plaintext matches)', () => {
    const a = encryptSecret('same', KEY);
    const b = encryptSecret('same', KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY));
  });

  it('passes through plaintext (rows written before a key was set)', () => {
    expect(isEncrypted('plain')).toBe(false);
    expect(decryptSecret('plain', KEY)).toBe('plain');
  });

  it('fails authentication on a tampered tag', () => {
    const ct = encryptSecret('secret', KEY);
    const parts = ct.split(':');
    parts[2] = Buffer.from('badtag-badtag-bad').toString('base64');
    expect(() => decryptSecret(parts.join(':'), KEY)).toThrow();
  });

  it('rejects a wrong-length key', () => {
    expect(() => encryptSecret('x', 'abcd')).toThrow(/32 bytes/);
  });
});
