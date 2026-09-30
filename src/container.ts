import { loadConfig, type AppConfig } from './config';
import { EidProviderRegistry, EidasGatewayProvider, FranceConnectProvider } from './identity/eidProvider';
import { LedgerChain } from './ledger/chain';
import { RiskEngine } from './risk/engine';
import { SanctionsScreener } from './risk/sanctions';
import { EnvelopeCipher, parseHexKey, type CipherKeyring } from './security/encryption';
import { KycService } from './services/kycService';
import { ListingGate } from './services/listingGate';
import { ReportService } from './services/reportService';
import { InMemoryKycRepository, type KycRepository } from './store/repository';
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
  ledger: LedgerChain;
  riskEngine: RiskEngine;
  cipher: EnvelopeCipher;
  providers: EidProviderRegistry;
  kycService: KycService;
  listingGate: ListingGate;
  reportService: ReportService;
  deps: AppDeps;
}

export interface BuildOptions {
  config?: AppConfig;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  repository?: KycRepository;
  ledger?: LedgerChain;
  riskEngine?: RiskEngine;
  logger?: Pick<Console, 'info'>;
  startedAt?: Date;
}

export function buildContainer(options: BuildOptions = {}): Container {
  const config = options.config ?? loadConfig(options.env ?? process.env);
  const clock = options.clock ?? systemClock;
  const repository = options.repository ?? new InMemoryKycRepository();
  const ledger = options.ledger ?? new LedgerChain();
  const providers = new EidProviderRegistry([
    new EidasGatewayProvider(config.eidSecrets.eidas),
    new FranceConnectProvider(config.eidSecrets.franceconnect),
  ]);
  const cipher = new EnvelopeCipher(buildKeyring(config));
  const riskEngine =
    options.riskEngine ?? new RiskEngine(new SanctionsScreener(undefined, config.sanctionsList));

  const kycService = new KycService({
    repository,
    ledger,
    riskEngine,
    cipher,
    providers,
    clock,
    credentialHashSalt: config.credentialHashSalt,
    logger: options.logger,
  });

  const listingGate = new ListingGate(repository, clock);
  const reportService = new ReportService(repository, clock, config.reportSigningKey);

  const deps: AppDeps = {
    config,
    clock,
    kycService,
    listingGate,
    reportService,
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
    deps,
  };
}

export function buildKeyring(config: AppConfig): CipherKeyring {
  const keys = new Map<string, Buffer>();
  if (config.masterKeyHex) {
    keys.set(config.masterKeyId, parseHexKey(config.masterKeyHex, config.masterKeyId));
  }
  return { activeKeyId: config.masterKeyId, keys };
}

/** Convenience helper for tests and the server: build the configured Express app. */
export function buildApp(options: BuildOptions = {}): { app: ReturnType<typeof createApp>; container: Container } {
  const container = buildContainer(options);
  return { app: createApp(container.deps), container };
}