import { loadConfig, type AppConfig } from './config';
import { EidProviderRegistry, EidasGatewayProvider, FranceConnectProvider, type EidProvider } from './identity/eidProvider';
import { LedgerChain } from './ledger/chain';
import { PolygonAdapter } from './ledger/polygonAdapter';
import type { LedgerAdapter } from './ledger/adapter';
import { RiskEngine } from './risk/engine';
import { SanctionsScreener } from './risk/sanctions';
import { EnvelopeCipher, parseHexKey, type CipherKeyring } from './security/encryption';
import { KycService } from './services/kycService';
import { ListingGate } from './services/listingGate';
import { ReportService, type ReportSigningKeys } from './services/reportService';
import { RetentionService, type RetentionPolicy, createDefaultRetentionPolicy } from './services/retentionService';
import { ConsentService, type ConsentPurpose } from './services/consentService';
import { InMemoryKycRepository, type KycRepository } from './store/repository';
import { createDynamoRepository } from './store/dynamoRepository';
import { systemClock, type Clock } from './util/clock';
import { createApp, type AppDeps } from './http/app';

/**
 * Composition root. Everything the product needs is constructed here from config
 * and injected, so tests can swap the repository, clock, keyring or sanctions
 * list without touching product code — and so the deployed topology can replace
 * the in-memory repository with DynamoDB without any other change.
 */
export interface Container {
  config: AppConfig;
  clock: Clock;
  repository: KycRepository;
  ledger: LedgerAdapter;
  riskEngine: RiskEngine;
  cipher: EnvelopeCipher;
  providers: EidProviderRegistry;
  kycService: KycService;
  listingGate: ListingGate;
  reportService: ReportService;
  retentionService: RetentionService;
  consentService: ConsentService;
  deps: AppDeps;
}

export interface BuildOptions {
  config?: AppConfig;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  repository?: KycRepository;
  ledger?: LedgerAdapter;
  riskEngine?: RiskEngine;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  startedAt?: Date;
  retentionPolicy?: Partial<RetentionPolicy>;
  consentVersion?: string;
  consentMandatoryPurposes?: ConsentPurpose[];
}

export function buildContainer(options: BuildOptions = {}): Container {
  const config = options.config ?? loadConfig(options.env ?? process.env);
  const clock = options.clock ?? systemClock;
  const repository = options.repository ?? buildRepository(config);
  const ledger = options.ledger ?? buildLedger(config);
  const providers = buildProviderRegistry(config);
  const cipher = new EnvelopeCipher(buildKeyring(config));
  const riskEngine =
    options.riskEngine ?? new RiskEngine(new SanctionsScreener(undefined, config.sanctionsList));

  const listingGate = new ListingGate(repository, clock);
  const signingKeys: ReportSigningKeys = {
    hmacKey: config.reportSigningKey,
    hmacKeyId: 'report-key-1',
    ecdsaPrivateKeyPem: config.reportEcdsaPrivateKey ?? undefined,
    ecdsaPublicKeyPem: config.reportEcdsaPublicKey ?? undefined,
    ecdsaKeyId: config.reportEcdsaKeyId ?? undefined,
  };
  const reportService = new ReportService(repository, clock, signingKeys);

  const retentionService = new RetentionService({
    policy: { ...createDefaultRetentionPolicy(), ...options.retentionPolicy },
    repository,
    clock,
    logger: options.logger,
  });

  const consentService = new ConsentService({
    repository,
    clock,
    currentVersion: options.consentVersion ?? '1.0.0',
    mandatoryPurposes: options.consentMandatoryPurposes ?? [],
    logger: options.logger,
  });

  const kycService = new KycService({
    repository,
    ledger,
    riskEngine,
    cipher,
    providers,
    clock,
    credentialHashSalt: config.credentialHashSalt,
    consentService,
    logger: options.logger,
  });

  const deps: AppDeps = {
    config,
    clock,
    kycService,
    listingGate,
    reportService,
    retentionService,
    consentService,
    repository,
    ledger,
    providerIds: providers.ids(),
    startedAt: options.startedAt ?? clock.now(),
  };

  return {
    config,
    clock,
    repository,
    ledger,
    riskEngine,
    cipher,
    providers,
    kycService,
    listingGate,
    reportService,
    retentionService,
    consentService,
    deps,
  };
}

function buildRepository(config: AppConfig): KycRepository {
  if (config.dynamodbTable) {
    return createDynamoRepository({
      tableName: config.dynamodbTable,
      region: config.dynamodbRegion ?? undefined,
      endpoint: config.dynamodbEndpoint ?? undefined,
    });
  }
  return new InMemoryKycRepository();
}

export function buildKeyring(config: AppConfig): CipherKeyring {
  const keys = new Map<string, Buffer>();
  if (config.masterKeyHex) {
    keys.set(config.masterKeyId, parseHexKey(config.masterKeyHex, config.masterKeyId));
  }
  return { activeKeyId: config.masterKeyId, keys };
}

function buildProviderRegistry(config: AppConfig): EidProviderRegistry {
  const providers: EidProvider[] = [];
  for (const providerId of config.enabledEidProviders) {
    if (providerId === 'eidas-gateway') {
      providers.push(new EidasGatewayProvider(config.eidSecrets.eidas));
    } else if (providerId === 'franceconnect') {
      providers.push(new FranceConnectProvider(config.eidSecrets.franceconnect));
    }
  }
  if (providers.length === 0) {
    throw new Error('No e-ID providers enabled — at least one must be configured');
  }
  return new EidProviderRegistry(providers);
}

function buildLedger(config: AppConfig): LedgerAdapter {
  const { rpcUrl, privateKey, contractAddress, chainId, gasLimit } = config.polygon;
  if (rpcUrl && privateKey && contractAddress) {
    return new PolygonAdapter({
      rpcUrl,
      privateKey,
      contractAddress,
      chainId: chainId ?? 1101,
      gasLimit: gasLimit ?? 100_000,
    });
  }
  return new LedgerChain();
}

/** Convenience helper for tests and the server: build the configured Express app. */
export function buildApp(options: BuildOptions = {}): { app: ReturnType<typeof createApp>; container: Container } {
  const container = buildContainer(options);
  return { app: createApp(container.deps), container };
}