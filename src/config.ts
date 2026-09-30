import { z } from 'zod';
import { parseHexKey } from './security/encryption';
import { sha256Hex } from './util/id';

/**
 * Environment configuration. Secrets are read from the process environment only
 * (see .env.example); nothing is hard-coded, and the service refuses to start in
 * production when a secret is missing rather than falling back to a default.
 */

const hexKey = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)');

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // AES-256-GCM keyring. Optional additional keys support rotation.
  KYC_MASTER_KEY: hexKey.optional(),
  KYC_MASTER_KEY_ID: z.string().min(1).default('k1'),
  KYC_PAST_KEYS: z.string().default(''),

  // Salt for credential digests (goes on-chain as part of the salted hash only).
  CREDENTIAL_HASH_SALT: z.string().optional(),

  // "key:marketplace" pairs. The API key is never stored, only its SHA-256.
  PARTNER_API_KEYS: z.string().optional(),

  // Secret used to sign generated compliance reports (HMAC-SHA256 today,
  // ECDSA P-256 once the PDF-signing pipeline lands).
  REPORT_SIGNING_KEY: z.string().optional(),

  // Shared secrets used by the e-ID adapter fixtures to validate assertions.
  EID_EIDAS_SECRET: z.string().optional(),
  EID_FRANCE_CONNECT_SECRET: z.string().optional(),

  SANCTIONS_LIST: z.string().default('eu-consolidated'),
});

export interface PartnerCredential {
  keyHash: string;
  marketplaceId: string;
}

export interface AppConfig {
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  masterKeyHex: string | null;
  masterKeyId: string;
  credentialHashSalt: string;
  partners: PartnerCredential[];
  reportSigningKey: string;
  eidSecrets: { eidas: string; franceconnect: string };
  sanctionsList: string;
  /** Warnings surfaced by /health so operators know a dev default is in use. */
  warnings: string[];
}

const DEV_MASTER_KEY = '0'.repeat(63) + '1';
const DEV_API_KEY = 'dev-key-local-only';
const DEV_PARTNER = 'dev-marketplace';

/**
 * A secret must either be supplied with real strength, or be absent and replaced
 * by a development placeholder with a warning. In production there is no third
 * option, so the process refuses to start.
 */
function requiredSecret(
  value: string | undefined,
  name: string,
  minimumLength: number,
  isProduction: boolean,
  warnings: string[],
): string {
  if (value) {
    if (value.length < minimumLength) {
      throw new Error(`${name} must be at least ${minimumLength} characters`);
    }
    return value;
  }
  if (isProduction) {
    throw new Error(`${name} must be set in production`);
  }
  warnings.push(`${name} not set — using a development-only placeholder`);
  return '';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const warnings: string[] = [];

  const masterKeyHex = parsed.KYC_MASTER_KEY ?? (parsed.NODE_ENV === 'production' ? null : DEV_MASTER_KEY);
  if (!masterKeyHex && parsed.NODE_ENV === 'production') {
    throw new Error('KYC_MASTER_KEY must be set in production');
  }
  if (!parsed.KYC_MASTER_KEY) {
    warnings.push('KYC_MASTER_KEY not set — using a development-only placeholder key');
  }

  const production = parsed.NODE_ENV === 'production';
  // Validated here so a bad rotation key fails at boot rather than at decrypt time.
  parsePastKeys(parsed.KYC_PAST_KEYS);
  if (masterKeyHex) parseHexKey(masterKeyHex, parsed.KYC_MASTER_KEY_ID);

  const configuredPartners = parsePartners(parsed.PARTNER_API_KEYS);
  if (configuredPartners.length === 0 && parsed.NODE_ENV === 'production') {
    // Never fall through to the development key in production: that would ship a
    // publicly known credential guarding every partner route.
    throw new Error('PARTNER_API_KEYS must list at least one partner key in production');
  }
  const partners = configuredPartners.length > 0 ? configuredPartners : developmentPartners(warnings);

  return {
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
    isProduction: parsed.NODE_ENV === 'production',
    masterKeyHex,
    masterKeyId: parsed.KYC_MASTER_KEY_ID,
    credentialHashSalt:
      requiredSecret(parsed.CREDENTIAL_HASH_SALT, 'CREDENTIAL_HASH_SALT', 16, production, warnings) ||
      'dev-credential-hash-salt-0001',
    partners,
    reportSigningKey:
      requiredSecret(parsed.REPORT_SIGNING_KEY, 'REPORT_SIGNING_KEY', 16, production, warnings) ||
      'dev-report-signing-key-0001',
    eidSecrets: {
      eidas: requiredSecret(parsed.EID_EIDAS_SECRET, 'EID_EIDAS_SECRET', 8, production, warnings) || 'dev-eidas-secret',
      franceconnect:
        requiredSecret(parsed.EID_FRANCE_CONNECT_SECRET, 'EID_FRANCE_CONNECT_SECRET', 8, production, warnings) ||
        'dev-franceconnect-secret',
    },
    sanctionsList: parsed.SANCTIONS_LIST,
    warnings,
  };
}

function parsePastKeys(raw: string): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
      throw new Error('KYC_PAST_KEYS entries must look like "<keyId>:<64 hex chars>"');
    }
    const keyId = trimmed.slice(0, separator);
    keys.set(keyId, parseHexKey(trimmed.slice(separator + 1), keyId));
  }
  return keys;
}

function developmentPartners(warnings: string[]): PartnerCredential[] {
  warnings.push('PARTNER_API_KEYS not set — using the development API key');
  return [{ keyHash: sha256Hex(DEV_API_KEY), marketplaceId: DEV_PARTNER }];
}

function parsePartners(raw: string | undefined): PartnerCredential[] {
  const pairs: PartnerCredential[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
      throw new Error('PARTNER_API_KEYS entries must look like "<apiKey>:<marketplaceId>"');
    }
    pairs.push({
      keyHash: sha256Hex(trimmed.slice(0, separator)),
      marketplaceId: trimmed.slice(separator + 1),
    });
  }
  return pairs;
}

export { DEV_API_KEY, DEV_MASTER_KEY, DEV_PARTNER };