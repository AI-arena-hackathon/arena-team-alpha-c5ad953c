import { buildContainer } from './container';
import { createApp } from './http/app';
import { loadConfig } from './config';
import { loadInitialSanctionsFeed } from './services/sanctionsFeedScheduler';

/**
 * Server bootstrap. Kept deliberately thin: everything interesting lives in the
 * container and the HTTP app, so `src/index.ts` is wiring plus a graceful
 * shutdown path (Lambda and container deployments both need one).
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // Load the live sanctions list before accepting traffic, so the very first
  // submission is screened against live data. A feed outage falls back to the
  // seeded EU list instead of failing startup, and the scheduler keeps trying
  // in the background.
  const sanctionsFeed = await loadInitialSanctionsFeed({
    url: config.sanctionsListUrl,
    minEntries: config.sanctionsFeedMinEntries,
    feedOptions: {
      timeoutMs: config.sanctionsFeedTimeoutMs,
      maxResponseSizeBytes: config.sanctionsFeedMaxSizeBytes,
    },
  });
  const container = buildContainer({ config, sanctionsFeed });

  for (const warning of container.config.warnings) {
    console.warn(`[config] ${warning}`);
  }

  const server = createApp(container.deps).listen(container.config.port, () => {
    console.log(
      `[nft-kyc-hub] listening on :${container.config.port} (${container.config.nodeEnv}) ` +
        `e-ID adapters: ${container.providers.ids().join(', ')}`,
    );
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[nft-kyc-hub] port ${container.config.port} is already in use`);
      process.exit(1);
    }
    throw error;
  });

  const shutdown = (signal: string): void => {
    console.log(`[nft-kyc-hub] ${signal} received, draining connections`);
    if (container.sanctionsScheduler) {
      console.log('[nft-kyc-hub] Stopping sanctions feed scheduler');
      container.sanctionsScheduler.stop();
    }
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[nft-kyc-hub] failed to start:', error);
  process.exit(1);
});