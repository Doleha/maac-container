import { createServer } from 'http';
import type { SessionState, ContainerStatus } from './types.js';

export function startHealthServer(getState: () => SessionState | null): void {
  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }

    if (req.url === '/health') {
      const state = getState();
      const status: ContainerStatus = deriveStatus(state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status,
        sessionId: state?.sessionId ?? null,
        requestCount: state?.requestCount ?? 0,
        scenariosReceived: state?.scenariosReceived ?? 0,
        scenariosComplete: state?.scenariosComplete ?? 0,
        retriesTotal: state?.retriesTotal ?? 0,
      }));
      return;
    }

    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(UI_HTML);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(8080, () => {
    console.log('[health] Listening on :8080');
  });

  server.on('error', (err) => {
    console.error('[health] Server error:', err.message);
  });
}

function deriveStatus(state: SessionState | null): ContainerStatus {
  if (!state) return 'ready';
  return state.status;
}

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MAAC Assessment</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .card {
      background: #1a1d27;
      border: 1px solid #2d3148;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 520px;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 32px;
    }

    .logo {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: #fff;
    }

    .logo span {
      color: #6366f1;
    }

    .status-badge {
      margin-left: auto;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .status-ready    { background: #1e2a3a; color: #60a5fa; }
    .status-running  { background: #1a2e1a; color: #4ade80; }
    .status-complete { background: #1a2e2e; color: #34d399; }
    .status-error    { background: #2e1a1a; color: #f87171; }

    .progress-section {
      margin-bottom: 28px;
    }

    .progress-label {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      color: #94a3b8;
      margin-bottom: 8px;
    }

    .progress-count {
      font-size: 13px;
      font-weight: 600;
      color: #e2e8f0;
    }

    .progress-track {
      height: 8px;
      background: #2d3148;
      border-radius: 4px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      border-radius: 4px;
      background: #6366f1;
      transition: width 0.4s ease;
    }

    .progress-fill.complete { background: #34d399; }
    .progress-fill.error    { background: #f87171; }

    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 28px;
    }

    .stat {
      background: #12151f;
      border: 1px solid #2d3148;
      border-radius: 8px;
      padding: 14px 16px;
    }

    .stat-label {
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: #64748b;
      margin-bottom: 4px;
    }

    .stat-value {
      font-size: 22px;
      font-weight: 700;
      color: #e2e8f0;
      line-height: 1;
    }

    .session-id {
      font-size: 11px;
      color: #475569;
      font-family: 'SF Mono', 'Fira Code', monospace;
      word-break: break-all;
      margin-bottom: 20px;
    }

    .session-id span {
      color: #64748b;
    }

    .footer {
      font-size: 11px;
      color: #334155;
      text-align: center;
    }

    .dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #4ade80;
      margin-right: 6px;
      animation: pulse 2s ease-in-out infinite;
    }

    .dot.idle    { background: #60a5fa; animation: none; }
    .dot.done    { background: #34d399; animation: none; }
    .dot.errored { background: #f87171; animation: none; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="logo">MAAC<span>verify</span></div>
      <div id="badge" class="status-badge status-ready">Ready</div>
    </div>

    <div class="progress-section">
      <div class="progress-label">
        <span><span id="dot" class="dot idle"></span>Scenarios</span>
        <span id="count" class="progress-count">— / —</span>
      </div>
      <div class="progress-track">
        <div id="bar" class="progress-fill" style="width:0%"></div>
      </div>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="stat-label">Complete</div>
        <div id="stat-complete" class="stat-value">0</div>
      </div>
      <div class="stat">
        <div class="stat-label">Retries</div>
        <div id="stat-retries" class="stat-value">0</div>
      </div>
    </div>

    <div class="session-id"><span>Session</span> <span id="session-value">—</span></div>

    <div class="footer" id="footer">Waiting for session to start&hellip;</div>
  </div>

  <script>
    const badge      = document.getElementById('badge');
    const dot        = document.getElementById('dot');
    const count      = document.getElementById('count');
    const bar        = document.getElementById('bar');
    const statComp   = document.getElementById('stat-complete');
    const statRet    = document.getElementById('stat-retries');
    const sessionVal = document.getElementById('session-value');
    const footer     = document.getElementById('footer');

    const STATUS_LABEL = { ready: 'Ready', running: 'Running', complete: 'Complete', error: 'Error' };
    const STATUS_CLASS = { ready: 'status-ready', running: 'status-running', complete: 'status-complete', error: 'status-error' };
    const DOT_CLASS    = { ready: 'idle', running: '', complete: 'done', error: 'errored' };

    function update(data) {
      const pct = data.requestCount > 0
        ? Math.round((data.scenariosComplete / data.requestCount) * 100)
        : 0;

      badge.className = 'status-badge ' + (STATUS_CLASS[data.status] ?? 'status-ready');
      badge.textContent = STATUS_LABEL[data.status] ?? data.status;

      dot.className = 'dot ' + (DOT_CLASS[data.status] ?? '');

      count.textContent = data.requestCount > 0
        ? data.scenariosComplete + ' / ' + data.requestCount
        : '— / —';

      bar.style.width = pct + '%';
      bar.className = 'progress-fill'
        + (data.status === 'complete' ? ' complete' : '')
        + (data.status === 'error'    ? ' error'    : '');

      statComp.textContent = data.scenariosComplete;
      statRet.textContent  = data.retriesTotal;

      sessionVal.textContent = data.sessionId ?? '—';

      if (data.status === 'complete') {
        footer.textContent = 'Assessment complete. This container will exit shortly.';
      } else if (data.status === 'error') {
        footer.textContent = 'Session ended with an error. Check the container logs.';
      } else if (data.status === 'running') {
        footer.textContent = 'Assessment in progress — this page updates automatically.';
      } else {
        footer.textContent = 'Waiting for session to start…';
      }
    }

    async function poll() {
      try {
        const res  = await fetch('/health');
        const data = await res.json();
        update(data);
      } catch {
        footer.textContent = 'Lost connection to container.';
      }
    }

    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>`;
