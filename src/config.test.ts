import { DEV_API_KEY, DEV_MASTER_KEY, loadConfig } from './config';
import { sha256Hex } from './util/id';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string> = {
    NODE_ENV: 'test',
    KYC_MASTER_KEY: 'a'.repeat(64),
    CREDENTIAL_HASH_SALT: 'test-credential-hash-salt',
    REPORT_SIGNING_KEY: 'test-report-signing-key',
    EID_EIDAS_SECRET: 'test-eidas-secret',
    EID_FRANCE_CONNECT_SECRET: 'test-fc-secret',
    PARTNER_API_KEYS: 'key-one:market-alpha,key-two:market-beta',
    ENABLED_EID_PROVIDERS: 'eidas-gateway,franceconnect',
  };
  // Apply overrides, removing keys set to undefined
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete base[key];
    } else {
      base[key] = value;
    }
  }
  return base as NodeJS.ProcessEnv;
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
    expect(() => loadConfig(env({ NODE_ENV: 'production', ENABLED_EID_PROVIDERS: undefined }))).toThrow(
      /ENABLED_EID_PROVIDERS must be set in production/,
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

  describe('config file loading', () => {
    let tempDir: string;
    let configFile: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'kyc-config-'));
      configFile = join(tempDir, 'config.json');
    });

    afterEach(() => {
      try {
        unlinkSync(configFile);
      } catch {
        // ignore cleanup errors
      }
    });

    it('loads config from JSON file when KYC_CONFIG_FILE is set', () => {
      writeFileSync(configFile, JSON.stringify({
        KYC_MASTER_KEY: 'b'.repeat(64),
        CREDENTIAL_HASH_SALT: 'file-credential-salt',
        REPORT_SIGNING_KEY: 'file-report-signing-key',
        EID_EIDAS_SECRET: 'file-eidas-secret',
        EID_FRANCE_CONNECT_SECRET: 'file-fc-secret',
        PARTNER_API_KEYS: 'file-key:file-market',
        ENABLED_EID_PROVIDERS: 'eidas-gateway',
        SANCTIONS_LIST: 'custom-list',
      }));

      const config = loadConfig(env({
        KYC_CONFIG_FILE: configFile,
        NODE_ENV: 'development',
        KYC_MASTER_KEY: undefined,
        CREDENTIAL_HASH_SALT: undefined,
        REPORT_SIGNING_KEY: undefined,
        EID_EIDAS_SECRET: undefined,
        EID_FRANCE_CONNECT_SECRET: undefined,
        PARTNER_API_KEYS: undefined,
        ENABLED_EID_PROVIDERS: undefined,
      }));

      expect(config.masterKeyHex).toBe('b'.repeat(64));
      expect(config.credentialHashSalt).toBe('file-credential-salt');
      expect(config.reportSigningKey).toBe('file-report-signing-key');
      expect(config.eidSecrets.eidas).toBe('file-eidas-secret');
      expect(config.eidSecrets.franceconnect).toBe('file-fc-secret');
      expect(config.partners).toEqual([
        { keyHash: sha256Hex('file-key'), marketplaceId: 'file-market' },
      ]);
      expect(config.sanctionsList).toBe('custom-list');
      expect(config.enabledEidProviders).toEqual(['eidas-gateway']);
    });

    it('environment variables take precedence over config file', () => {
      writeFileSync(configFile, JSON.stringify({
        KYC_MASTER_KEY: 'b'.repeat(64),
        CREDENTIAL_HASH_SALT: 'file-salt',
        PORT: 8080,
      }));

      const config = loadConfig(env({
        KYC_CONFIG_FILE: configFile,
        KYC_MASTER_KEY: 'c'.repeat(64), // env overrides file
        CREDENTIAL_HASH_SALT: 'env-salt-long-enough', // env overrides file
      }));

      expect(config.masterKeyHex).toBe('c'.repeat(64)); // env wins
      expect(config.credentialHashSalt).toBe('env-salt-long-enough'); // env wins
      expect(config.port).toBe(8080); // from config file (PORT not in env)
    });

    it('throws on missing config file', () => {
      expect(() => loadConfig(env({
        KYC_CONFIG_FILE: '/nonexistent/path/config.json',
      }))).toThrow(/Config file not found/);
    });

    it('throws on invalid JSON in config file', () => {
      writeFileSync(configFile, '{ invalid json }');
      expect(() => loadConfig(env({ KYC_CONFIG_FILE: configFile }))).toThrow(/not valid JSON/);
    });

    it('throws when config file root is not an object', () => {
      writeFileSync(configFile, '["array", "not", "object"]');
      expect(() => loadConfig(env({ KYC_CONFIG_FILE: configFile }))).toThrow(/JSON object/);
    });

    it('enables only specified e-ID providers from config file', () => {
      writeFileSync(configFile, JSON.stringify({
        KYC_MASTER_KEY: 'b'.repeat(64),
        CREDENTIAL_HASH_SALT: 'salt-long-enough-for-test',
        REPORT_SIGNING_KEY: 'key-long-enough-for-test',
        EID_EIDAS_SECRET: 'secret',
        EID_FRANCE_CONNECT_SECRET: 'secret',
        PARTNER_API_KEYS: 'k:m',
        ENABLED_EID_PROVIDERS: 'franceconnect',
      }));

      const config = loadConfig(env({
        KYC_CONFIG_FILE: configFile,
        KYC_MASTER_KEY: undefined,
        CREDENTIAL_HASH_SALT: undefined,
        REPORT_SIGNING_KEY: undefined,
        ENABLED_EID_PROVIDERS: undefined,
      }));
      expect(config.enabledEidProviders).toEqual(['franceconnect']);
    });

    it('rejects unknown e-ID provider in config file', () => {
      writeFileSync(configFile, JSON.stringify({
        KYC_MASTER_KEY: 'b'.repeat(64),
        CREDENTIAL_HASH_SALT: 'salt-long-enough-for-test',
        REPORT_SIGNING_KEY: 'key-long-enough-for-test',
        EID_EIDAS_SECRET: 'secret',
        EID_FRANCE_CONNECT_SECRET: 'secret',
        PARTNER_API_KEYS: 'k:m',
        ENABLED_EID_PROVIDERS: 'unknown-provider',
      }));

      expect(() => loadConfig(env({
        KYC_CONFIG_FILE: configFile,
        KYC_MASTER_KEY: undefined,
        CREDENTIAL_HASH_SALT: undefined,
        REPORT_SIGNING_KEY: undefined,
        ENABLED_EID_PROVIDERS: undefined,
      }))).toThrow(/Unknown e-ID provider/);
    });
  });
});