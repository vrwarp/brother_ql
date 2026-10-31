/**
 * Entry point: read the environment, open the state file, start listening.
 */

import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createBridgeServer, ensureAdminToken } from './server.js';
import { Store } from './store.js';

const log = createLogger();

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await Store.open(config.dataDir);
  await ensureAdminToken(config, store, log);
  const bridge = createBridgeServer({ config, store, log });
  await bridge.start();

  const shutdown = (signal: string): void => {
    log('info', 'shutting down', { signal });
    void bridge.stop().then(() => process.exit(0));
    // A client mid-job can hold the server open; do not let it hold the
    // container's stop past the grace period.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  log('error', 'failed to start', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
