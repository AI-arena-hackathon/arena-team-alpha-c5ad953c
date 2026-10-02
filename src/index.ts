import { buildContainer } from './container';
import { createApp } from './http/app';
import { loadConfig } from './config';
import { loadSanctionsFeed, type SanctionsFeed } from './risk/sanctions';

/**
 * Fetch the live sanctions list when SANCTIONS_LIST_URL is configured. A feed
 * outage must not take the service down, so failures are logged and the caller
 * falls back to the seeded EU consolidated list.
 */
async function resolveSanctionsFeed(url: string | null): Promise<SanctionsFeed | undefined> {
  if (!url) return undefined;
  try {
    return await loadSanctionsFeed(url);
  } catch (error) {
    console.error(
      `[nft-kyc-hub] failed to load sanctions feed ${url}, using seeded list:`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

/**
 * Server bootstrap. Kept deliberately thin: everything interesting lives in the
 * container and the HTTP app, so `src/index.ts` is wiring plus a graceful
 * shutdown path (Lambda and container deployments both need one).
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const sanctionsFeed = await resolveSanctionsFeed(config.sanctionsListUrl);
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
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[nft-kyc-hub] failed to start:', error);
  process.exit(1);
});