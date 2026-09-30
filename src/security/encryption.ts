import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { canonicalJson } from '../util/canonical';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * AES-256-GCM envelope for the personal data captured by a KYC submission.
 *
 * Design notes:
 * - Every record gets a fresh random IV; reusing an IV under one key would leak
 *   plaintext structure, so the IV is stored per envelope, never derived.
 * - The submission id is bound in as additional authenticated data, so an
 *   envelope cannot be replayed under a different record id.
 * - Only the ciphertext envelope is persisted next to the KYC metadata. The key
 *   itself never leaves KMS in the deployed topology (see README risk section);
 *   here keys are injected so tests can pin them.
 * - `keyId` travels with the envelope so keys can be rotated without a rewrite.
 */
export interface EncryptedEnvelope {
  alg: typeof ALGORITHM;
  keyId: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface CipherKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

export class EnvelopeCipher {
  constructor(private readonly keyring: CipherKeyring) {}

  get activeKeyId(): string {
    return this.keyring.activeKeyId;
  }

  encrypt(plaintext: unknown, aad: string): EncryptedEnvelope {
    const key = this.key(this.keyring.activeKeyId);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(canonicalJson(plaintext), 'utf8')),
      cipher.final(),
    ]);

    return {
      alg: ALGORITHM,
      keyId: this.keyring.activeKeyId,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  decrypt(envelope: EncryptedEnvelope, aad: string): unknown {
    const key = this.key(envelope.keyId);
    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8'));
    } catch {
      // Never surface the underlying OpenSSL message: it distinguishes a wrong
      // key from tampered ciphertext, which is oracle information.
      throw new EncryptionError('envelope failed authentication (wrong key, wrong AAD or tampered ciphertext)');
    }
  }

  private key(keyId: string): Buffer {
    const key = this.keyring.keys.get(keyId);
    if (!key) {
      throw new EncryptionError(`unknown key id "${keyId}"`);
    }
    return key;
  }
}

/**
 * Salted digest of a verified credential. This — never the credential itself —
 * is what gets anchored to the ledger and quoted in compliance reports, so the
 * chain carries tamper-evidence without carrying personal data (README risk 2).
 */
export function credentialDigest(params: {
  subjectId: string;
  assertion: string;
  salt: string;
}): string {
  return createHmac('sha256', params.salt)
    .update(canonicalJson({ subjectId: params.subjectId, assertion: params.assertion }))
    .digest('hex');
}

/** Deterministic digest of any JSON value, used for idempotency and chain links. */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Constant-time string comparison for secrets (API keys, signatures). */
export function safeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function deriveKey(material: string, keyId: string): Buffer {
  return createHash('sha256').update(`${keyId}:${material}`, 'utf8').digest();
}

export function parseHexKey(hex: string, keyId: string): Buffer {
  const buffer = Buffer.from(hex, 'hex');
  if (buffer.length !== KEY_BYTES) {
    throw new EncryptionError(
      `key "${keyId}" must be ${KEY_BYTES} bytes (64 hex chars), received ${buffer.length}`,
    );
  }
  return buffer;
}

export { KEY_BYTES, IV_BYTES, AUTH_TAG_BYTES, ALGORITHM };