import { buildApp, buildContainer, buildKeyring } from './container';
import { InMemoryKycRepository } from './store/repository';
import { LedgerChain } from './ledger/chain';
import { RiskEngine } from './risk/engine';
import { fixedClock } from './util/clock';
import { TEST_API_KEY, TEST_MARKETPLACE, TEST_NOW, testConfig } from './testing/fixtures';

describe('buildContainer', () => {
  it('wires every dependency from config alone', () => {
    const container = buildContainer({ config: testConfig(), clock: fixedClock(TEST_NOW) });

    expect(container.providers.ids()).toEqual(['eidas-gateway', 'franceconnect']);
    expect(container.cipher.activeKeyId).toBe('k-test');
    expect(container.ledger).toBeInstanceOf(LedgerChain);
    expect(container.repository).toBeInstanceOf(InMemoryKycRepository);
    expect(container.riskEngine).toBeInstanceOf(RiskEngine);
    expect(container.deps.startedAt).toEqual(new Date(TEST_NOW));
  });

  it('accepts injected collaborators so tests and infrastructure can swap them', async () => {
    const repository = new InMemoryKycRepository();
    const ledger = new LedgerChain();
    const riskEngine = new RiskEngine();
    const container = buildContainer({
      config: testConfig(),
      clock: fixedClock(TEST_NOW),
      repository,
      ledger,
      riskEngine,
      startedAt: new Date('2025-01-01T00:00:00.000Z'),
    });

    expect(container.repository).toBe(repository);
    expect(container.ledger).toBe(ledger);
    expect(container.riskEngine).toBe(riskEngine);
    expect(container.deps.startedAt).toEqual(new Date('2025-01-01T00:00:00.000Z'));
    expect(await repository.listByMarketplace(TEST_MARKETPLACE)).toEqual([]);
  });

  it('reads the environment when no config is supplied', () => {
    const container = buildContainer({
      env: {
        NODE_ENV: 'test',
        PARTNER_API_KEYS: `${TEST_API_KEY}:${TEST_MARKETPLACE}`,
        KYC_MASTER_KEY: 'd'.repeat(64),
        CREDENTIAL_HASH_SALT: 'salt-from-environment',
        REPORT_SIGNING_KEY: 'report-key-from-env',
        EID_EIDAS_SECRET: 'eidas-from-env',
        EID_FRANCE_CONNECT_SECRET: 'fc-from-env',
      } as NodeJS.ProcessEnv,
      clock: fixedClock(TEST_NOW),
    });

    expect(container.config.partners[0].marketplaceId).toBe(TEST_MARKETPLACE);
    expect(container.config.credentialHashSalt).toBe('salt-from-environment');
  });

  it('builds an app and a container together', () => {
    const { app, container } = buildApp({ config: testConfig(), clock: fixedClock(TEST_NOW) });
    expect(typeof app.listen).toBe('function');
    expect(container.config.nodeEnv).toBe('test');
  });
});

describe('buildKeyring', () => {
  it('registers the active key from config', () => {
    const keyring = buildKeyring(testConfig());
    expect(keyring.activeKeyId).toBe('k-test');
    expect(keyring.keys.get('k-test')).toHaveLength(32);
  });

  it('produces an empty keyring when no master key is configured', () => {
    const keyring = buildKeyring(testConfig({ masterKeyHex: null }));
    expect(keyring.keys.size).toBe(0);
  });
});