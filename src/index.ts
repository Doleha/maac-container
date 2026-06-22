import { loadConfig } from './config.js';
import { startHealthServer } from './health.js';
import { runTunnel } from './tunnel.js';
import type { SessionState } from './types.js';

console.log('[maac-container] Starting up...');

const config = loadConfig();

let currentState: SessionState | null = null;

startHealthServer(() => currentState);

console.log(`[maac-container] Format: ${config.clientAiFormat} | Endpoint: ${config.clientAiEndpoint}`);
console.log(`[maac-container] Server: ${config.maacServerUrl}`);
console.log('[maac-container] Connecting...');

runTunnel(config, (state) => {
  currentState = state;
}).then(() => {
  console.log('[maac-container] Session complete — exiting cleanly');
  process.exit(0);
}).catch((err: unknown) => {
  console.error('[maac-container] Fatal error:', (err as Error).message);
  process.exit(1);
});
