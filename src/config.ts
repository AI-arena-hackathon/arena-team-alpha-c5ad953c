import { z } from 'zod';
import { parseHexKey } from './security/encryption';
import { sha256Hex } from './util/id';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Environment configuration. Secrets are read from the process environment only
 * (see .env.example); nothing is hard-coded, and the service refuses to start in
 * production when a secret is missing rather than falling back to a default.
 * 
 * Configuration can also be loaded from a JSON file specified by KYC_CONFIG_FILE.
 * Environment variables take precedence over file values.
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

  // Enabled e-ID providers (comma-separated: eidas-gateway,franceconnect)
  // Defaults to both in development; in production at least one must be explicitly enabled.
  ENABLED_EID_PROVIDERS: z.string().optional(),

  // Config file support
  KYC_CONFIG_FILE: z.string().optional(),

  // DynamoDB configuration (for production repository)
  KYC_DYNAMODB_TABLE: z.string().optional(),
  KYC_DYNAMODB_REGION: z.string().optional(),
  KYC_DYNAMODB_ENDPOINT: z.string().optional(),
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
  /** Enabled e-ID provider IDs (e.g., ['eidas-gateway', 'franceconnect']). */
  enabledEidProviders: string[];
  /** Warnings surfaced by /health so operators know a dev default is in use. */
  warnings: string[];
  /** DynamoDB table name for the KYC repository (production). */
  dynamodbTable: string | null;
  /** DynamoDB region (defaults to AWS default region chain). */
  dynamodbRegion: string | null;
  /** DynamoDB endpoint override (for local testing with DynamoDB Local). */
  dynamodbEndpoint: string | null;
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

/** Load and parse the JSON config file if KYC_CONFIG_FILE is set. */
function loadConfigFile(env: NodeJS.ProcessEnv): Record<string, string> {
  const configFile = env.KYC_CONFIG_FILE;
  if (!configFile) return {};

  const absolutePath = resolve(configFile);
  try {
    const content = readFileSync(absolutePath, 'utf8');
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Config file must contain a JSON object');
    }
    // Flatten to string key-value pairs for merging with env
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== null && value !== undefined) {
        flat[key] = String(value);
      }
    }
    return flat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Config file not found: ${absolutePath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Config file is not valid JSON: ${absolutePath}`);
    }
    throw error;
  }
}

/** Merge config file values into env, with env vars taking precedence. */
function mergeConfigFile(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const fileConfig = loadConfigFile(env);
  const merged = { ...env };
  for (const [key, value] of Object.entries(fileConfig)) {
    if (!(key in merged)) {
      merged[key] = value;
    }
  }
  return merged;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Load config file first, then merge env on top (env wins)
  const mergedEnv = mergeConfigFile(env);
  const parsed = envSchema.parse(mergedEnv);
  const warnings: string[] = [];

  const masterKeyHex = parsed.KYC_MASTER_KEY ?? (parsed.NODE_ENV === 'production' ? null : DEV_MASTER_KEY);
  if (!masterKeyHex && parsed.NODE_ENV === 'production') {
    throw new Error('KYC_MASTER_KEY must be set in production');
  }
  if (!parsed.KYC_MASTER_KEY && !mergedEnv.KYC_CONFIG_FILE) {
    // Only warn if not provided via config file either
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

  // Parse enabled e-ID providers
  const enabledEidProviders = parseEnabledEidProviders(parsed.ENABLED_EID_PROVIDERS, production, warnings);

  // DynamoDB configuration
  const dynamodbTable = parsed.KYC_DYNAMODB_TABLE ?? null;
  const dynamodbRegion = parsed.KYC_DYNAMODB_REGION ?? null;
  const dynamodbEndpoint = parsed.KYC_DYNAMODB_ENDPOINT ?? null;

  if (production && !dynamodbTable) {
    warnings.push('KYC_DYNAMODB_TABLE not set — using in-memory repository (not suitable for production)');
  }

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
    enabledEidProviders,
    warnings,
    dynamodbTable,
    dynamodbRegion,
    dynamodbEndpoint,
  };
}

function parseEnabledEidProviders(raw: string | undefined, isProduction: boolean, warnings: string[]): string[] {
  const knownProviders = ['eidas-gateway', 'franceconnect'];
  if (raw) {
    const enabled = raw.split(',').map(s => s.trim()).filter(Boolean);
    for (const provider of enabled) {
      if (!knownProviders.includes(provider)) {
        throw new Error(`Unknown e-ID provider: ${provider}. Known: ${knownProviders.join(', ')}`);
      }
    }
    if (enabled.length === 0) {
      throw new Error('ENABLED_EID_PROVIDERS must list at least one provider');
    }
    return enabled;
  }
  // Default: both in development; production requires explicit config
  if (isProduction) {
    throw new Error('ENABLED_EID_PROVIDERS must be set in production (e.g., "eidas-gateway,franceconnect")');
  }
  warnings.push('ENABLED_EID_PROVIDERS not set — enabling all providers for development');
  return knownProviders;
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