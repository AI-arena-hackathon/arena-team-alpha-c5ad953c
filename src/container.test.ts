import { buildApp, buildContainer, buildKeyring } from './container';
import { InMemoryKycRepository } from './store/repository';
import { LedgerChain } from './ledger/chain';
import { RiskEngine } from './risk/engine';
import { fixedClock } from './util/clock';
import { JwksVerifier } from './identity/jwksVerifier';
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

  it('swaps in the real JWKS verifier when a JWKS endpoint is configured', () => {
    const container = buildContainer({
      config: testConfig({
        enabledEidProviders: ['eidas-gateway'],
        eidEidasJwks: {
          uri: 'https://eidas.example.test/.well-known/jwks.json',
          issuer: 'https://eidas.example.test',
          audience: 'nft-kyc-hub',
        },
      }),
      clock: fixedClock(TEST_NOW),
    });

    const provider = container.providers.find('eidas');
    expect(provider).toBeInstanceOf(JwksVerifier);
    expect(provider?.id).toBe('eidas-gateway');
    expect(provider?.minimumAssurance).toBe('high');
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

  it('screens against an injected live sanctions feed instead of the seeded list', () => {
    const container = buildContainer({
      config: testConfig({ sanctionsList: 'eu-consolidated' }),
      clock: fixedClock(TEST_NOW),
      sanctionsFeed: {
        listName: 'eu-consolidated',
        entries: [{ reference: 'EU.9999.01', name: 'Live Feed Target', programme: 'EU 9999' }],
      },
    });

    const assessment = container.riskEngine.assess({
      subjectId: 'subject-1',
      fullName: 'Live Feed Target',
      dateOfBirth: '1980-01-01',
      countryCode: 'PT',
      documentType: 'passport',
      documentExpiresOn: '2030-01-01',
      wallet: {
        address: '0x' + '2'.repeat(40),
        firstSeenAt: '2020-01-01T00:00:00.000Z',
        transactionCount: 100,
        volumeUsd: 1000,
      },
      claims: { politicallyExposed: false, sourceOfFunds: 'salary' },
      identity: {
        verified: true,
        provider: 'eidas-gateway',
        assertion: {
          subjectId: 'subject-1',
          fullName: 'Live Feed Target',
          dateOfBirth: '1980-01-01',
          assurance: 'high',
          method: 'eidas-aalink:passport',
          issuer: 'https://eidas.example.test',
          issuedAt: '2025-01-01T00:00:00.000Z',
          expiresAt: '2026-01-01T00:00:00.000Z',
          claims: {},
        },
      },
      consentGranted: true,
      now: new Date(TEST_NOW),
    });

    expect(assessment.sanctionsHits).toHaveLength(1);
    expect(assessment.sanctionsHits[0].reference).toBe('EU.9999.01');
    expect(assessment.decision).toBe('reject');
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