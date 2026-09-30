import { DEV_API_KEY, DEV_MASTER_KEY, loadConfig } from './config';
import { sha256Hex } from './util/id';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    KYC_MASTER_KEY: 'a'.repeat(64),
    CREDENTIAL_HASH_SALT: 'test-credential-hash-salt',
    REPORT_SIGNING_KEY: 'test-report-signing-key',
    EID_EIDAS_SECRET: 'test-eidas-secret',
    EID_FRANCE_CONNECT_SECRET: 'test-fc-secret',
    PARTNER_API_KEYS: 'key-one:market-alpha,key-two:market-beta',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('loadConfig', () => {
  it('maps partner API keys to marketplace ids without keeping the key', () => {
    const config = loadConfig(env());
    expect(config.partners).toEqual([
      { keyHash: sha256Hex('key-one'), marketplaceId: 'market-alpha' },
      { keyHash: sha256Hex('key-two'), marketplaceId: 'market-beta' },
    ]);
    expect(JSON.stringify(config)).not.toContain('key-one');
    expect(config.warnings).toEqual([]);
  });

  it('accepts several rotation keys', () => {
    const config = loadConfig(
      env({ KYC_PAST_KEYS: `k-old:${'b'.repeat(64)},k-older:${'c'.repeat(64)}` }),
    );
    expect(config.masterKeyId).toBe('k1');
  });

  it('rejects malformed key material instead of starting insecurely', () => {
    expect(() => loadConfig(env({ KYC_MASTER_KEY: 'short' }))).toThrow(/64 hex/);
    expect(() => loadConfig(env({ KYC_PAST_KEYS: 'missing-separator' }))).toThrow(/keyId/);
    expect(() => loadConfig(env({ PARTNER_API_KEYS: 'no-marketplace-id' }))).toThrow(/marketplace/);
  });

  it('falls back to development placeholders outside production, loudly', () => {
    const config = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(config.masterKeyHex).toBe(DEV_MASTER_KEY);
    expect(config.partners).toEqual([
      { keyHash: sha256Hex(DEV_API_KEY), marketplaceId: 'dev-marketplace' },
    ]);
    expect(config.warnings.join(' ')).toMatch(/KYC_MASTER_KEY not set/);
    expect(config.warnings.join(' ')).toMatch(/PARTNER_API_KEYS not set/);
  });

  it('refuses to start in production without secrets', () => {
    const production = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(() => loadConfig(production)).toThrow(/KYC_MASTER_KEY must be set in production/);

    expect(() => loadConfig(env({ NODE_ENV: 'production', KYC_MASTER_KEY: undefined }))).toThrow(
      /KYC_MASTER_KEY/,
    );
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', PARTNER_API_KEYS: '' })),
    ).toThrow(/PARTNER_API_KEYS must list at least one partner key/);
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', CREDENTIAL_HASH_SALT: undefined })),
    ).toThrow(/CREDENTIAL_HASH_SALT must be set in production/);
    expect(() => loadConfig(env({ NODE_ENV: 'production', REPORT_SIGNING_KEY: undefined }))).toThrow(
      /REPORT_SIGNING_KEY must be set in production/,
    );
    expect(() => loadConfig(env({ NODE_ENV: 'production', EID_EIDAS_SECRET: undefined }))).toThrow(
      /EID_EIDAS_SECRET must be set in production/,
    );
  });

  it('boots in production with every secret present', () => {
    const config = loadConfig(env({ NODE_ENV: 'production' }));
    expect(config.isProduction).toBe(true);
    expect(config.warnings).toEqual([]);
  });

  it('applies documented defaults', () => {
    const config = loadConfig(env({ PORT: undefined, SANCTIONS_LIST: undefined }));
    expect(config.port).toBe(3000);
    expect(config.sanctionsList).toBe('eu-consolidated');
    expect(config.masterKeyId).toBe('k1');
  });

  it('rejects a secret that is present but too weak, in every environment', () => {
    expect(() => loadConfig(env({ CREDENTIAL_HASH_SALT: 'short' }))).toThrow(/at least 16 characters/);
    expect(() => loadConfig(env({ REPORT_SIGNING_KEY: 'short' }))).toThrow(/at least 16 characters/);
    expect(() => loadConfig(env({ EID_EIDAS_SECRET: 'short' }))).toThrow(/at least 8 characters/);
  });

  it('rejects a nonsensical port', () => {
    expect(() => loadConfig(env({ PORT: '99999' }))).toThrow();
    expect(() => loadConfig(env({ PORT: 'not-a-port' }))).toThrow();
  });
});