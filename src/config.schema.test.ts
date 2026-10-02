import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_PATH = join(__dirname, '..', 'config.schema.json');

function loadSchema() {
  const content = readFileSync(SCHEMA_PATH, 'utf8');
  return JSON.parse(content);
}

describe('config.schema.json', () => {
  let ajv: Ajv;
  let validate: ValidateFunction;

  beforeAll(() => {
    ajv = new Ajv({ allErrors: true, strict: true });
    const schema = loadSchema();
    validate = ajv.compile(schema);
  });

  it('validates a minimal development config', () => {
    const config = {
      NODE_ENV: 'development',
    };
    expect(validate(config)).toBe(true);
  });

  it('validates a complete development config with all fields', () => {
    const config = {
      PORT: 3111,
      NODE_ENV: 'development',
      KYC_MASTER_KEY: 'a'.repeat(64),
      KYC_MASTER_KEY_ID: 'k1',
      KYC_PAST_KEYS: '',
      CREDENTIAL_HASH_SALT: 'dev-credential-hash-salt-0001',
      PARTNER_API_KEYS: 'dev-key-local-only:dev-marketplace',
      REPORT_SIGNING_KEY: 'dev-report-signing-key-0001',
      EID_EIDAS_SECRET: 'dev-eidas-secret',
      EID_FRANCE_CONNECT_SECRET: 'dev-franceconnect-secret',
      SANCTIONS_LIST: 'eu-consolidated',
      ENABLED_EID_PROVIDERS: 'eidas-gateway,franceconnect',
    };
    expect(validate(config)).toBe(true);
  });

  it('validates a complete production config', () => {
    const config = {
      PORT: 3000,
      NODE_ENV: 'production',
      KYC_MASTER_KEY: 'b5f8e3d2c1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4',
      KYC_MASTER_KEY_ID: 'k1',
      KYC_PAST_KEYS: 'k0:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
      CREDENTIAL_HASH_SALT: 'prod-credential-hash-salt-2025-01-15',
      PARTNER_API_KEYS: 'prod-api-key-1:marketplace-alpha,prod-api-key-2:marketplace-beta',
      REPORT_SIGNING_KEY: 'prod-report-signing-key-2025-01-15-very-long',
      EID_EIDAS_SECRET: 'prod-eidas-gateway-shared-secret-2025',
      EID_FRANCE_CONNECT_SECRET: 'prod-franceconnect-shared-secret-2025',
      SANCTIONS_LIST: 'eu-consolidated',
      ENABLED_EID_PROVIDERS: 'eidas-gateway,franceconnect',
    };
    expect(validate(config)).toBe(true);
  });

  it('rejects invalid NODE_ENV', () => {
    const config = { NODE_ENV: 'staging' };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'enum', instancePath: '/NODE_ENV' }),
      ]),
    );
  });

  it('rejects invalid PORT (out of range)', () => {
    const config = { PORT: 99999 };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'maximum', instancePath: '/PORT' }),
      ]),
    );
  });

  it('rejects invalid KYC_MASTER_KEY format', () => {
    const config = { KYC_MASTER_KEY: 'not-hex' };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'pattern', instancePath: '/KYC_MASTER_KEY' }),
      ]),
    );
  });

  it('rejects KYC_MASTER_KEY wrong length', () => {
    const config = { KYC_MASTER_KEY: 'a'.repeat(63) };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'pattern', instancePath: '/KYC_MASTER_KEY' }),
      ]),
    );
  });

  it('rejects invalid KYC_PAST_KEYS format', () => {
    const config = { KYC_PAST_KEYS: 'invalid-format' };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'pattern', instancePath: '/KYC_PAST_KEYS' }),
      ]),
    );
  });

  it('rejects CREDENTIAL_HASH_SALT too short', () => {
    const config = { CREDENTIAL_HASH_SALT: 'short' };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'minLength', instancePath: '/CREDENTIAL_HASH_SALT' }),
      ]),
    );
  });

  it('rejects invalid PARTNER_API_KEYS format', () => {
    const config = { PARTNER_API_KEYS: 'no-colon' };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'pattern', instancePath: '/PARTNER_API_KEYS' }),
      ]),
    );
  });

  it('rejects REPORT_SIGNING_KEY too short', () => {
    const config = { REPORT_SIGNING_KEY: 'short' };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'minLength', instancePath: '/REPORT_SIGNING_KEY' }),
      ]),
    );
  });

  it('rejects EID secrets too short', () => {
    const config = { EID_EIDAS_SECRET: 'short' };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'minLength', instancePath: '/EID_EIDAS_SECRET' }),
      ]),
    );
  });

  it('accepts JWKS configuration for both providers', () => {
    const config = {
      EID_EIDAS_JWKS_URI: 'https://eidas.example.test/.well-known/jwks.json',
      EID_EIDAS_ISSUER: 'https://eidas.example.test',
      EID_EIDAS_AUDIENCE: 'nft-kyc-hub',
      EID_FRANCE_CONNECT_JWKS_URI: 'https://fc.example.test/.well-known/jwks.json',
      EID_FRANCE_CONNECT_ISSUER: 'https://fc.example.test',
    };
    expect(validate(config)).toBe(true);
  });

  it('rejects a JWKS URI that is not http(s)', () => {
    const config = { EID_EIDAS_JWKS_URI: 'ftp://eidas.example.test/jwks.json' };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'pattern', instancePath: '/EID_EIDAS_JWKS_URI' }),
      ]),
    );
  });

  it('rejects a sanctions feed URL that is not http(s)', () => {
    const config = { SANCTIONS_LIST_URL: 'not-a-url' };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'pattern', instancePath: '/SANCTIONS_LIST_URL' }),
      ]),
    );
  });

  it('rejects unknown ENABLED_EID_PROVIDERS value', () => {
    const config = { ENABLED_EID_PROVIDERS: 'unknown-provider' };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'pattern', instancePath: '/ENABLED_EID_PROVIDERS' }),
      ]),
    );
  });

  it('rejects empty ENABLED_EID_PROVIDERS', () => {
    const config = { ENABLED_EID_PROVIDERS: '' };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'pattern', instancePath: '/ENABLED_EID_PROVIDERS' }),
      ]),
    );
  });

  it('rejects additional properties not in schema', () => {
    const config = { NODE_ENV: 'development', UNKNOWN_FIELD: 'value' };
    expect(validate(config)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'additionalProperties' }),
      ]),
    );
  });

  it('accepts valid KYC_PAST_KEYS with multiple rotation keys', () => {
    const config = {
      KYC_PAST_KEYS: 'k-old:' + 'b'.repeat(64) + ',k-older:' + 'c'.repeat(64),
    };
    expect(validate(config)).toBe(true);
  });

  it('accepts single e-ID provider', () => {
    const config = { ENABLED_EID_PROVIDERS: 'franceconnect' };
    expect(validate(config)).toBe(true);
  });

  it('validates the example configs from the schema', () => {
    const schema = loadSchema();
    for (const example of schema.examples ?? []) {
      expect(validate(example)).toBe(true);
    }
  });
});