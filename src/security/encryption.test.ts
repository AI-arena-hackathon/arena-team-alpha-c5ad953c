import {
  credentialDigest,
  deriveKey,
  digestOf,
  EnvelopeCipher,
  EncryptionError,
  parseHexKey,
  safeEqual,
  type CipherKeyring,
} from './encryption';

const AAD = 'kyc_submission_0001';

function cipherWith(keys: Record<string, string>, activeKeyId = 'k1'): EnvelopeCipher {
  const map = new Map<string, Buffer>();
  for (const [keyId, hex] of Object.entries(keys)) map.set(keyId, parseHexKey(hex, keyId));
  const keyring: CipherKeyring = { activeKeyId, keys: map };
  return new EnvelopeCipher(keyring);
}

const personalData = {
  fullName: 'Ines Ferreira',
  dateOfBirth: '1991-04-17',
  document: { number: 'PT4417X', type: 'passport' },
};

describe('EnvelopeCipher', () => {
  const cipher = cipherWith({ k1: 'a'.repeat(64) });

  it('round-trips personal data through an AES-256-GCM envelope', () => {
    const envelope = cipher.encrypt(personalData, AAD);
    expect(envelope.alg).toBe('aes-256-gcm');
    expect(envelope.keyId).toBe('k1');
    expect(cipher.decrypt(envelope, AAD)).toEqual(personalData);
  });

  it('never leaves plaintext in the stored envelope', () => {
    const envelope = cipher.encrypt(personalData, AAD);
    const serialised = JSON.stringify(envelope);
    expect(serialised).not.toContain('Ines Ferreira');
    expect(serialised).not.toContain('1991-04-17');
    expect(serialised).not.toContain('PT4417X');
    expect(Buffer.from(envelope.ciphertext, 'base64').toString('utf8')).not.toContain('Ferreira');
  });

  it('uses a fresh IV per envelope so identical payloads do not collide', () => {
    const first = cipher.encrypt(personalData, AAD);
    const second = cipher.encrypt(personalData, AAD);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('rejects an envelope replayed under a different submission id (AAD binding)', () => {
    const envelope = cipher.encrypt(personalData, AAD);
    expect(() => cipher.decrypt(envelope, 'kyc_submission_0002')).toThrow(EncryptionError);
  });

  it('detects tampering with the ciphertext', () => {
    const envelope = cipher.encrypt(personalData, AAD);
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    bytes[0] = bytes[0] ^ 0xff;
    const tampered = { ...envelope, ciphertext: bytes.toString('base64') };
    expect(() => cipher.decrypt(tampered, AAD)).toThrow(EncryptionError);
  });

  it('detects tampering with the auth tag', () => {
    const envelope = cipher.encrypt(personalData, AAD);
    const tag = Buffer.from(envelope.authTag, 'base64');
    tag[0] = tag[0] ^ 0xff;
    expect(() => cipher.decrypt({ ...envelope, authTag: tag.toString('base64') }, AAD)).toThrow(
      EncryptionError,
    );
  });

  it('refuses to decrypt with the wrong key', () => {
    const envelope = cipher.encrypt(personalData, AAD);
    const other = cipherWith({ k1: 'b'.repeat(64) });
    expect(() => other.decrypt(envelope, AAD)).toThrow(EncryptionError);
  });

  it('rejects an unknown key id rather than falling back to the active key', () => {
    const envelope = cipher.encrypt(personalData, AAD);
    expect(() => cipher.decrypt({ ...envelope, keyId: 'retired' }, AAD)).toThrow(/unknown key id/);
  });

  it('decrypts historical records after a key rotation', () => {
    const before = cipherWith({ k1: 'a'.repeat(64) });
    const envelope = before.encrypt(personalData, AAD);
    const after = cipherWith({ k1: 'a'.repeat(64), k2: 'c'.repeat(64) }, 'k2');
    expect(after.activeKeyId).toBe('k2');
    expect(after.decrypt(envelope, AAD)).toEqual(personalData);
    expect(after.decrypt(after.encrypt(personalData, AAD), AAD)).toEqual(personalData);
  });

  it('does not leak whether the failure was a bad key or bad ciphertext', () => {
    const envelope = cipher.encrypt(personalData, AAD);
    let message = '';
    try {
      cipherWith({ k1: 'b'.repeat(64) }).decrypt(envelope, AAD);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('failed authentication');
    expect(message).not.toMatch(/unsupported state|bad decrypt|unable to decrypt/i);
  });
});

describe('parseHexKey', () => {
  it('accepts a 32-byte hex key', () => {
    expect(parseHexKey('f'.repeat(64), 'k1')).toHaveLength(32);
  });

  it.each(['abc', 'f'.repeat(63), 'g'.repeat(64), ''])('rejects %p as a key material', (value) => {
    expect(() => parseHexKey(value, 'k1')).toThrow(EncryptionError);
  });
});

describe('credentialDigest', () => {
  it('is deterministic for the same subject, assertion and salt', () => {
    const args = { subjectId: 'seller-777', assertion: 'payload.sig', salt: 'salt-1' };
    expect(credentialDigest(args)).toBe(credentialDigest({ ...args }));
    expect(credentialDigest(args)).toHaveLength(64);
  });

  it('changes when the salt changes, so digests cannot be correlated across environments', () => {
    const base = { subjectId: 'seller-777', assertion: 'payload.sig' };
    expect(credentialDigest({ ...base, salt: 'salt-1' })).not.toBe(credentialDigest({ ...base, salt: 'salt-2' }));
  });

  it('changes when the subject changes, preventing cross-subject correlation', () => {
    const base = { assertion: 'payload.sig', salt: 'salt-1' };
    expect(credentialDigest({ ...base, subjectId: 'a' })).not.toBe(credentialDigest({ ...base, subjectId: 'b' }));
  });
});

describe('digestOf', () => {
  it('is stable across key order and sensitive to value changes', () => {
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
  });
});

describe('safeEqual', () => {
  it('matches identical strings and rejects different ones', () => {
    expect(safeEqual('key', 'key')).toBe(true);
    expect(safeEqual('key', 'ke')).toBe(false);
    expect(safeEqual('key', '')).toBe(false);
  });
});

describe('deriveKey', () => {
  it('produces a 32-byte key bound to the key id', () => {
    expect(deriveKey('material', 'k1')).toHaveLength(32);
    expect(deriveKey('material', 'k1').equals(deriveKey('material', 'k1'))).toBe(true);
    expect(deriveKey('material', 'k1').equals(deriveKey('material', 'k2'))).toBe(false);
  });
});