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

/**
 * Boolean from an environment variable or a JSON config file.
 *
 * `z.coerce.boolean()` is a trap here: it applies JavaScript truthiness, so the
 * string "false" — what an operator writes to switch a feature off — becomes
 * `true`. Only the documented spellings are accepted, and anything else fails
 * loudly at startup rather than silently choosing a default.
 */
const envBoolean = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])])
    .transform((value) =>
      typeof value === 'boolean' ? value : ['true', '1', 'yes', 'on'].includes(value),
    )
    .default(defaultValue);

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
  REPORT_ECDSA_PRIVATE_KEY: z.string().optional(),
  REPORT_ECDSA_PUBLIC_KEY: z.string().optional(),
  REPORT_ECDSA_KEY_ID: z.string().optional(),

  // Shared secrets used by the e-ID adapter fixtures to validate assertions (legacy HMAC mode).
  EID_EIDAS_SECRET: z.string().optional(),
  EID_FRANCE_CONNECT_SECRET: z.string().optional(),

  // JWKS endpoints for real eIDAS PKI/JWKS validation (production mode).
  EID_EIDAS_JWKS_URI: z.string().url().optional(),
  EID_EIDAS_ISSUER: z.string().optional(),
  EID_EIDAS_AUDIENCE: z.string().optional(),
  EID_FRANCE_CONNECT_JWKS_URI: z.string().url().optional(),
  EID_FRANCE_CONNECT_ISSUER: z.string().optional(),
  EID_FRANCE_CONNECT_AUDIENCE: z.string().optional(),

  SANCTIONS_LIST: z.string().default('eu-consolidated'),
  SANCTIONS_LIST_URL: z.string().url().optional(),
  SANCTIONS_FEED_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  SANCTIONS_FEED_MAX_SIZE_BYTES: z.coerce.number().int().positive().default(5_242_880),
  SANCTIONS_FEED_REFRESH_ENABLED: envBoolean(true),
  SANCTIONS_FEED_REFRESH_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),
  SANCTIONS_FEED_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  SANCTIONS_FEED_BASE_RETRY_DELAY_MS: z.coerce.number().int().positive().default(5_000),
  SANCTIONS_FEED_MAX_RETRY_DELAY_MS: z.coerce.number().int().positive().default(300_000),
  SANCTIONS_FEED_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(5),
  SANCTIONS_FEED_CIRCUIT_BREAKER_RESET_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  SANCTIONS_FEED_MIN_ENTRIES: z.coerce.number().int().positive().default(1),

  // Enabled e-ID providers (comma-separated: eidas-gateway,franceconnect)
  // Defaults to both in development; in production at least one must be explicitly enabled.
  ENABLED_EID_PROVIDERS: z.string().optional(),

  // Config file support
  KYC_CONFIG_FILE: z.string().optional(),

  // DynamoDB configuration (for production repository)
  KYC_DYNAMODB_TABLE: z.string().optional(),
  KYC_DYNAMODB_REGION: z.string().optional(),
  KYC_DYNAMODB_ENDPOINT: z.string().optional(),

  // Polygon zk-EVM anchoring (production ledger)
  KYC_POLYGON_RPC_URL: z.string().url().optional(),
  KYC_POLYGON_PRIVATE_KEY: hexKey.optional(),
  KYC_POLYGON_CONTRACT_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  KYC_POLYGON_CHAIN_ID: z.coerce.number().int().positive().optional(),
  KYC_POLYGON_GAS_LIMIT: z.coerce.number().int().positive().optional(),
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
  reportEcdsaPrivateKey: string | null;
  reportEcdsaPublicKey: string | null;
  reportEcdsaKeyId: string | null;
  eidSecrets: { eidas: string; franceconnect: string };
  /** JWKS configuration for eIDAS Gateway (real PKI validation). */
  eidEidasJwks: {
    uri: string | null;
    issuer: string | null;
    audience: string | null;
  };
  /** JWKS configuration for FranceConnect (real PKI validation). */
  eidFranceConnectJwks: {
    uri: string | null;
    issuer: string | null;
    audience: string | null;
  };
  sanctionsList: string;
  /** Optional URL to fetch live sanctions list feed. */
  sanctionsListUrl: string | null;
  /** Request timeout for sanctions feed fetch (ms). */
  sanctionsFeedTimeoutMs: number;
  /** Maximum response body size for sanctions feed (bytes). */
  sanctionsFeedMaxSizeBytes: number;
  /** Enable scheduled sanctions feed refresh. */
  sanctionsFeedRefreshEnabled: boolean;
  /** Refresh interval for sanctions feed (ms). */
  sanctionsFeedRefreshIntervalMs: number;
  /** Maximum retry attempts for feed refresh. */
  sanctionsFeedMaxRetries: number;
  /** Base retry delay for feed refresh (ms). */
  sanctionsFeedBaseRetryDelayMs: number;
  /** Maximum retry delay for feed refresh (ms). */
  sanctionsFeedMaxRetryDelayMs: number;
  /** Circuit breaker: open after this many consecutive failures. */
  sanctionsFeedCircuitBreakerThreshold: number;
  /** Circuit breaker: time in ms before attempting to close (half-open). */
  sanctionsFeedCircuitBreakerResetTimeoutMs: number;
  /**
   * Refuse to install a refreshed sanctions feed with fewer entries than this.
   * Guards against an upstream outage silently replacing the list with an
   * empty one and stopping screening.
   */
  sanctionsFeedMinEntries: number;
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
  /** Polygon zk-EVM anchoring configuration. */
  polygon: {
    rpcUrl: string | null;
    privateKey: string | null;
    contractAddress: string | null;
    chainId: number | null;
    gasLimit: number | null;
  };
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

  const enabledEidProviders = parseEnabledEidProviders(parsed.ENABLED_EID_PROVIDERS, production, warnings);

  // JWKS configuration for real PKI validation
  const eidEidasJwks = {
    uri: parsed.EID_EIDAS_JWKS_URI ?? null,
    issuer: parsed.EID_EIDAS_ISSUER ?? null,
    audience: parsed.EID_EIDAS_AUDIENCE ?? null,
  };
  const eidFranceConnectJwks = {
    uri: parsed.EID_FRANCE_CONNECT_JWKS_URI ?? null,
    issuer: parsed.EID_FRANCE_CONNECT_ISSUER ?? null,
    audience: parsed.EID_FRANCE_CONNECT_AUDIENCE ?? null,
  };
  const eidasJwksActive = Boolean(eidEidasJwks.uri && eidEidasJwks.issuer);
  const franceConnectJwksActive = Boolean(eidFranceConnectJwks.uri && eidFranceConnectJwks.issuer);

  // DynamoDB configuration
  const dynamodbTable = parsed.KYC_DYNAMODB_TABLE ?? null;
  const dynamodbRegion = parsed.KYC_DYNAMODB_REGION ?? null;
  const dynamodbEndpoint = parsed.KYC_DYNAMODB_ENDPOINT ?? null;

  if (production && !dynamodbTable) {
    warnings.push('KYC_DYNAMODB_TABLE not set — using in-memory repository (not suitable for production)');
  }

  // Polygon configuration
  const polygonRpcUrl = parsed.KYC_POLYGON_RPC_URL ?? null;
  const polygonPrivateKey = parsed.KYC_POLYGON_PRIVATE_KEY ?? null;
  const polygonContractAddress = parsed.KYC_POLYGON_CONTRACT_ADDRESS ?? null;
  const polygonChainId = parsed.KYC_POLYGON_CHAIN_ID ?? null;
  const polygonGasLimit = parsed.KYC_POLYGON_GAS_LIMIT ?? null;

  if (production && (polygonRpcUrl || polygonPrivateKey || polygonContractAddress)) {
    if (!polygonRpcUrl) warnings.push('KYC_POLYGON_RPC_URL not set — Polygon anchoring incomplete');
    if (!polygonPrivateKey) warnings.push('KYC_POLYGON_PRIVATE_KEY not set — Polygon anchoring incomplete');
    if (!polygonContractAddress) warnings.push('KYC_POLYGON_CONTRACT_ADDRESS not set — Polygon anchoring incomplete');
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
    reportEcdsaPrivateKey: parsed.REPORT_ECDSA_PRIVATE_KEY ?? null,
    reportEcdsaPublicKey: parsed.REPORT_ECDSA_PUBLIC_KEY ?? null,
    reportEcdsaKeyId: parsed.REPORT_ECDSA_KEY_ID ?? null,
    eidSecrets: {
      // A provider configured with JWKS validates signatures against the vendor's
      // published keys, so its shared HMAC secret is unused and not required.
      eidas: eidasJwksActive
        ? ''
        : requiredSecret(parsed.EID_EIDAS_SECRET, 'EID_EIDAS_SECRET', 8, production, warnings) ||
          'dev-eidas-secret',
      franceconnect: franceConnectJwksActive
        ? ''
        : requiredSecret(parsed.EID_FRANCE_CONNECT_SECRET, 'EID_FRANCE_CONNECT_SECRET', 8, production, warnings) ||
          'dev-franceconnect-secret',
    },
    eidEidasJwks,
    eidFranceConnectJwks,
    sanctionsList: parsed.SANCTIONS_LIST,
    sanctionsListUrl: parsed.SANCTIONS_LIST_URL ?? null,
    sanctionsFeedTimeoutMs: parsed.SANCTIONS_FEED_TIMEOUT_MS,
    sanctionsFeedMaxSizeBytes: parsed.SANCTIONS_FEED_MAX_SIZE_BYTES,
    sanctionsFeedRefreshEnabled: parsed.SANCTIONS_FEED_REFRESH_ENABLED,
    sanctionsFeedRefreshIntervalMs: parsed.SANCTIONS_FEED_REFRESH_INTERVAL_MS,
    sanctionsFeedMaxRetries: parsed.SANCTIONS_FEED_MAX_RETRIES,
    sanctionsFeedBaseRetryDelayMs: parsed.SANCTIONS_FEED_BASE_RETRY_DELAY_MS,
    sanctionsFeedMaxRetryDelayMs: parsed.SANCTIONS_FEED_MAX_RETRY_DELAY_MS,
    sanctionsFeedCircuitBreakerThreshold: parsed.SANCTIONS_FEED_CIRCUIT_BREAKER_THRESHOLD,
    sanctionsFeedCircuitBreakerResetTimeoutMs: parsed.SANCTIONS_FEED_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    sanctionsFeedMinEntries: parsed.SANCTIONS_FEED_MIN_ENTRIES,
    enabledEidProviders,
    warnings,
    dynamodbTable,
    dynamodbRegion,
    dynamodbEndpoint,
    polygon: {
      rpcUrl: polygonRpcUrl,
      privateKey: polygonPrivateKey,
      contractAddress: polygonContractAddress,
      chainId: polygonChainId,
      gasLimit: polygonGasLimit,
    },
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