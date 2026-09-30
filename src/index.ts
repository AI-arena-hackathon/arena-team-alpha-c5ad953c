import { buildContainer } from './container';
import { createApp } from './http/app';

/**
 * Server bootstrap. Kept deliberately thin: everything interesting lives in the
 * container and the HTTP app, so `src/index.ts` is wiring plus a graceful
 * shutdown path (Lambda and container deployments both need one).
 */
function main(): void {
  const container = buildContainer();

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

main();