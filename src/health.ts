import { createServer } from 'http';
import type { SessionState, ContainerStatus } from './types.js';

export function startHealthServer(getState: () => SessionState | null): void {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404);
      res.end();
      return;
    }

    const state = getState();
    const status: ContainerStatus = deriveStatus(state);

    const body = JSON.stringify({
      status,
      sessionId: state?.sessionId ?? null,
      scenariosReceived: state?.scenariosReceived ?? 0,
      scenariosComplete: state?.scenariosComplete ?? 0,
      retriesTotal: state?.retriesTotal ?? 0,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });

  server.listen(8080, () => {
    console.log('[health] HTTP server listening on :8080');
  });

  server.on('error', (err) => {
    console.error('[health] Server error:', err.message);
  });
}

function deriveStatus(state: SessionState | null): ContainerStatus {
  if (!state) return 'ready';
  return state.status;
}
