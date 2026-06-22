import { createServer, IncomingMessage } from 'http';
import type { SessionState, ContainerStatus } from './types.js';
import type { Config } from './config.js';
import { SCENARIO_SCHEMA, validateBatch } from './schema.js';
import { preflightAi } from './relay.js';

// Safe view of config for the UI — secrets reported as booleans only.
function safeConfig(config: Config) {
  return {
    serverUrl: config.maacServerUrl,
    suggestedApiBaseUrl: deriveApiBaseUrl(config.maacServerUrl),
    aiEndpoint: config.clientAiEndpoint,
    aiFormat: config.clientAiFormat,
    aiModel: config.clientAiModel ?? null,
    timeoutMs: config.clientAiTimeoutMs,
    maxRetries: config.clientAiMaxRetries,
    hasApiKey: Boolean(config.clientApiKey),
    hasAiAuthToken: Boolean(config.clientAiAuthToken),
    hasCustomTemplate: Boolean(config.customBodyTemplate),
  };
}

// Turns the wss:// assessment URL into a best-guess https:// API base for the
// import endpoint. The client can override it in the UI.
function deriveApiBaseUrl(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    const proto = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    return `${proto}//${u.host}`;
  } catch {
    return '';
  }
}

function readBody(req: IncomingMessage, limitBytes = 25 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// Parses a request body that may be a JSON array, a { scenarios: [...] }
// envelope, or newline-delimited JSON. Returns records or throws.
function parseScenarioRecords(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  // Try JSON first (array or envelope).
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { scenarios?: unknown }).scenarios)) {
      return (parsed as { scenarios: unknown[] }).scenarios;
    }
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    // fall through to ndjson
  }
  // Newline-delimited JSON.
  return trimmed.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

// ── Per-IP rate limiting for the /api/* endpoints ────────────────────────────
// The UI server is internal-only, but the amplification endpoints (preflight
// issues a model call; submit makes an authenticated outbound call) warrant a
// cap. Fixed-window per-IP counters, pruned periodically. The UI ( / ) and
// /health are not limited — they are cheap and /health is polled every 2s.
const RL_WINDOW_MS = 60_000;
const RL_DEFAULT_MAX = 120;
const RL_ENDPOINT_MAX: Record<string, number> = {
  '/api/preflight': 6,
  '/api/submit': 10,
};
const rlBuckets = new Map<string, { count: number; resetAt: number }>();

function rlConsume(ip: string, max: number): boolean {
  const now = Date.now();
  const bucket = rlBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rlBuckets.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

const rlSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rlBuckets) {
    if (now > bucket.resetAt) rlBuckets.delete(ip);
  }
}, RL_WINDOW_MS);
rlSweep.unref();

export function startHealthServer(config: Config, getState: () => SessionState | null): void {
  const sendJson = (res: import('http').ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    // Rate-limit the /api/* surface per client IP.
    if (url.startsWith('/api/')) {
      const ip = req.socket.remoteAddress ?? 'unknown';
      const max = RL_ENDPOINT_MAX[url] ?? RL_DEFAULT_MAX;
      if (!rlConsume(ip, max)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }
    }

    // ── Static / read-only ───────────────────────────────────────────────
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(UI_HTML);
      return;
    }

    if (req.method === 'GET' && url === '/health') {
      const state = getState();
      sendJson(res, 200, {
        status: deriveStatus(state),
        sessionId: state?.sessionId ?? null,
        requestCount: state?.requestCount ?? 0,
        scenariosReceived: state?.scenariosReceived ?? 0,
        scenariosComplete: state?.scenariosComplete ?? 0,
        retriesTotal: state?.retriesTotal ?? 0,
      });
      return;
    }

    if (req.method === 'GET' && url === '/api/config') {
      sendJson(res, 200, safeConfig(config));
      return;
    }

    if (req.method === 'GET' && url === '/api/schema') {
      sendJson(res, 200, SCENARIO_SCHEMA);
      return;
    }

    if (req.method === 'GET' && url === '/api/preflight') {
      preflightAi(config)
        .then((result) => sendJson(res, 200, result))
        .catch((err: unknown) => sendJson(res, 200, { ok: false, statusCode: 0, latencyMs: 0, error: (err as Error).message }));
      return;
    }

    // ── Validation ───────────────────────────────────────────────────────
    if (req.method === 'POST' && url === '/api/validate') {
      readBody(req)
        .then((raw) => {
          let records: unknown[];
          try {
            records = parseScenarioRecords(raw);
          } catch (err) {
            sendJson(res, 400, { error: `Could not parse scenarios: ${(err as Error).message}` });
            return;
          }
          const results = validateBatch(records);
          sendJson(res, 200, {
            total: results.length,
            valid: results.filter((r) => r.valid).length,
            invalid: results.filter((r) => !r.valid).length,
            results,
          });
        })
        .catch((err: unknown) => sendJson(res, 400, { error: (err as Error).message }));
      return;
    }

    // ── Submit to MAAC server (proxy) ────────────────────────────────────
    if (req.method === 'POST' && url === '/api/submit') {
      handleSubmit(req, res, sendJson).catch((err: unknown) =>
        sendJson(res, 500, { error: (err as Error).message }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const port = Number(process.env.HEALTH_PORT) || 8080;
  server.listen(port, () => {
    console.log(`[health] UI + API listening on :${port}`);
  });

  server.on('error', (err) => {
    console.error('[health] Server error:', err.message);
  });
}

async function handleSubmit(
  req: IncomingMessage,
  res: import('http').ServerResponse,
  sendJson: (res: import('http').ServerResponse, code: number, body: unknown) => void,
): Promise<void> {
  const raw = await readBody(req);
  let payload: { apiBaseUrl?: unknown; apiKey?: unknown; records?: unknown };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    sendJson(res, 400, { error: 'Body must be JSON: { apiBaseUrl, apiKey, records }' });
    return;
  }

  const apiBaseUrl = typeof payload.apiBaseUrl === 'string' ? payload.apiBaseUrl.trim().replace(/\/+$/, '') : '';
  const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey : '';
  const records = Array.isArray(payload.records) ? payload.records : [];

  if (!/^https?:\/\//.test(apiBaseUrl)) {
    sendJson(res, 400, { error: 'apiBaseUrl must be an http(s) URL' });
    return;
  }
  if (!apiKey) {
    sendJson(res, 400, { error: 'apiKey is required' });
    return;
  }

  // Validate locally first; only forward conformant records.
  const results = validateBatch(records);
  const validRecords = records.filter((_, i) => results[i].valid);
  const localRejections = results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !r.valid)
    .map(({ r, i }) => ({ line: i + 1, scenarioId: r.scenarioId, reason: r.errors.join('; ') }));

  if (validRecords.length === 0) {
    sendJson(res, 422, {
      error: 'No valid records to submit',
      localRejections,
    });
    return;
  }

  const ndjson = validRecords.map((r) => JSON.stringify(r)).join('\n');
  const importUrl = `${apiBaseUrl}/api/assessment/scenarios/import`;

  let upstream: Response;
  try {
    upstream = await fetch(importUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${apiKey}`,
      },
      body: ndjson,
    });
  } catch (err) {
    sendJson(res, 502, { error: `Could not reach MAAC server: ${(err as Error).message}`, localRejections });
    return;
  }

  let upstreamBody: unknown = null;
  try {
    upstreamBody = await upstream.json();
  } catch {
    upstreamBody = null;
  }

  sendJson(res, upstream.ok ? 200 : upstream.status, {
    submitted: validRecords.length,
    localRejections,
    serverStatus: upstream.status,
    serverResponse: upstreamBody,
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
  <title>MAAC Container</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f1117; color: #e2e8f0; min-height: 100vh; padding: 24px;
    }
    .wrap { max-width: 820px; margin: 0 auto; }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
    .logo { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; color: #fff; }
    .logo span { color: #6366f1; }
    .status-badge {
      margin-left: auto; padding: 4px 12px; border-radius: 20px; font-size: 12px;
      font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .status-ready { background: #1e2a3a; color: #60a5fa; }
    .status-running { background: #1a2e1a; color: #4ade80; }
    .status-complete { background: #1a2e2e; color: #34d399; }
    .status-error { background: #2e1a1a; color: #f87171; }
    .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid #2d3148; }
    .tab {
      padding: 10px 18px; cursor: pointer; font-size: 14px; font-weight: 500;
      color: #94a3b8; border-bottom: 2px solid transparent; background: none; border-top: none;
      border-left: none; border-right: none;
    }
    .tab.active { color: #fff; border-bottom-color: #6366f1; }
    .panel { display: none; }
    .panel.active { display: block; }
    .card { background: #1a1d27; border: 1px solid #2d3148; border-radius: 12px; padding: 28px; }
    .card + .card { margin-top: 16px; }
    h2 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: #cbd5e1; }
    .progress-label { display: flex; justify-content: space-between; font-size: 13px; color: #94a3b8; margin-bottom: 8px; }
    .progress-count { font-weight: 600; color: #e2e8f0; }
    .progress-track { height: 8px; background: #2d3148; border-radius: 4px; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 4px; background: #6366f1; transition: width 0.4s ease; }
    .progress-fill.complete { background: #34d399; }
    .progress-fill.error { background: #f87171; }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 20px; }
    .stat { background: #12151f; border: 1px solid #2d3148; border-radius: 8px; padding: 14px 16px; }
    .stat-label { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.6px; color: #64748b; margin-bottom: 4px; }
    .stat-value { font-size: 22px; font-weight: 700; color: #e2e8f0; line-height: 1; }
    .session-id { font-size: 11px; color: #475569; font-family: 'SF Mono', monospace; word-break: break-all; margin-top: 16px; }
    .session-id span { color: #64748b; }
    label { display: block; font-size: 12px; color: #94a3b8; margin: 14px 0 6px; }
    textarea, input[type=text], input[type=password] {
      width: 100%; background: #12151f; border: 1px solid #2d3148; border-radius: 8px;
      color: #e2e8f0; padding: 10px 12px; font-size: 13px; font-family: 'SF Mono', monospace;
    }
    textarea { min-height: 180px; resize: vertical; }
    input[type=file] { font-size: 13px; color: #94a3b8; }
    button.action {
      margin-top: 16px; background: #6366f1; color: #fff; border: none; border-radius: 8px;
      padding: 10px 18px; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    button.action:hover { background: #4f51d6; }
    button.action.secondary { background: #2d3148; }
    button.action:disabled { opacity: 0.5; cursor: not-allowed; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .result-line { font-size: 12px; padding: 8px 10px; border-radius: 6px; margin-top: 6px; font-family: 'SF Mono', monospace; }
    .result-ok { background: #14241a; color: #6ee7a8; }
    .result-bad { background: #281618; color: #fca5a5; }
    .summary { font-size: 13px; margin: 12px 0; color: #cbd5e1; }
    .kv { display: flex; justify-content: space-between; font-size: 13px; padding: 8px 0; border-bottom: 1px solid #20242f; }
    .kv:last-child { border-bottom: none; }
    .kv .k { color: #94a3b8; }
    .kv .v { color: #e2e8f0; font-family: 'SF Mono', monospace; }
    .pill { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    .pill.yes { background: #14241a; color: #6ee7a8; }
    .pill.no { background: #281618; color: #fca5a5; }
    .hint { font-size: 12px; color: #64748b; margin-top: 8px; line-height: 1.5; }
    a { color: #818cf8; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="logo">MAAC<span>verify</span></div>
      <div id="badge" class="status-badge status-ready">Ready</div>
    </div>

    <div class="tabs">
      <button class="tab active" data-tab="session">Session</button>
      <button class="tab" data-tab="scenarios">Scenarios</button>
      <button class="tab" data-tab="preflight">Preflight</button>
    </div>

    <!-- SESSION -->
    <div class="panel active" id="panel-session">
      <div class="card">
        <h2>Live assessment progress</h2>
        <div class="progress-label">
          <span>Scenarios</span>
          <span id="count" class="progress-count">— / —</span>
        </div>
        <div class="progress-track"><div id="bar" class="progress-fill" style="width:0%"></div></div>
        <div class="stats">
          <div class="stat"><div class="stat-label">Complete</div><div id="stat-complete" class="stat-value">0</div></div>
          <div class="stat"><div class="stat-label">Retries</div><div id="stat-retries" class="stat-value">0</div></div>
        </div>
        <div class="session-id"><span>Session</span> <span id="session-value">—</span></div>
        <div class="hint" id="session-footer">Waiting for session to start…</div>
      </div>
    </div>

    <!-- SCENARIOS -->
    <div class="panel" id="panel-scenarios">
      <div class="card">
        <h2>Validate &amp; submit scenarios</h2>
        <div class="hint">Paste a JSON array, a <code>{ "scenarios": [...] }</code> envelope, or newline-delimited JSON — or load a <code>.json</code> / <code>.jsonl</code> file. Records are checked against the MAAC scenario schema before submission. <a href="/api/schema" target="_blank">View schema</a>.</div>
        <label>Scenarios</label>
        <textarea id="scenario-input" placeholder='[{"scenarioId":"...","experimentId":"...","configId":"...","modelId":"...","taskTitle":"...","taskDescription":"..."}]'></textarea>
        <div class="row">
          <input type="file" id="scenario-file" accept=".json,.jsonl,.ndjson,application/json">
          <button class="action secondary" id="btn-validate">Validate</button>
        </div>
        <div id="validate-results"></div>
      </div>

      <div class="card" id="submit-card" style="display:none">
        <h2>Submit to MAAC server</h2>
        <label>MAAC server API base URL</label>
        <input type="text" id="api-base" placeholder="https://api.maacverify.ai">
        <label>Tenant API key</label>
        <input type="password" id="api-key" placeholder="Your tenant API key (kept in this browser only)">
        <div class="hint">The key is sent once, through this container, to the import endpoint. It is never stored.</div>
        <button class="action" id="btn-submit" disabled>Submit valid records</button>
        <div id="submit-results"></div>
      </div>
    </div>

    <!-- PREFLIGHT -->
    <div class="panel" id="panel-preflight">
      <div class="card">
        <h2>Configuration</h2>
        <div id="config-body"><div class="hint">Loading…</div></div>
      </div>
      <div class="card">
        <h2>AI endpoint connectivity</h2>
        <div class="hint">Sends one minimal request to your model endpoint to confirm it is reachable and authenticated. This issues a single model call.</div>
        <button class="action secondary" id="btn-preflight">Test endpoint</button>
        <div id="preflight-results"></div>
      </div>
    </div>
  </div>

  <script>
    const STATUS_LABEL = { ready: 'Ready', running: 'Running', complete: 'Complete', error: 'Error' };
    const STATUS_CLASS = { ready: 'status-ready', running: 'status-running', complete: 'status-complete', error: 'status-error' };

    // Tabs
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        document.getElementById('panel-' + t.dataset.tab).classList.add('active');
        if (t.dataset.tab === 'preflight') loadConfig();
      });
    });

    // Session polling
    const badge = document.getElementById('badge');
    function applyStatus(status) {
      badge.className = 'status-badge ' + (STATUS_CLASS[status] || 'status-ready');
      badge.textContent = STATUS_LABEL[status] || status;
    }
    async function pollSession() {
      try {
        const data = await (await fetch('/health')).json();
        applyStatus(data.status);
        const pct = data.requestCount > 0 ? Math.round((data.scenariosComplete / data.requestCount) * 100) : 0;
        document.getElementById('count').textContent = data.requestCount > 0 ? data.scenariosComplete + ' / ' + data.requestCount : '— / —';
        const bar = document.getElementById('bar');
        bar.style.width = pct + '%';
        bar.className = 'progress-fill' + (data.status === 'complete' ? ' complete' : '') + (data.status === 'error' ? ' error' : '');
        document.getElementById('stat-complete').textContent = data.scenariosComplete;
        document.getElementById('stat-retries').textContent = data.retriesTotal;
        document.getElementById('session-value').textContent = data.sessionId || '—';
        const f = document.getElementById('session-footer');
        f.textContent = data.status === 'complete' ? 'Assessment complete. This container will exit shortly.'
          : data.status === 'error' ? 'Session ended with an error. Check the container logs.'
          : data.status === 'running' ? 'Assessment in progress — updates automatically.'
          : 'Waiting for session to start…';
      } catch {
        document.getElementById('session-footer').textContent = 'Lost connection to container.';
      }
    }
    pollSession();
    setInterval(pollSession, 2000);

    // Scenarios
    let lastValidRecords = [];
    const fileInput = document.getElementById('scenario-file');
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (file) document.getElementById('scenario-input').value = await file.text();
    });

    document.getElementById('btn-validate').addEventListener('click', async () => {
      const raw = document.getElementById('scenario-input').value;
      const box = document.getElementById('validate-results');
      box.innerHTML = '<div class="hint">Validating…</div>';
      try {
        const resp = await fetch('/api/validate', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: raw });
        const data = await resp.json();
        if (!resp.ok) { box.innerHTML = '<div class="result-line result-bad">' + (data.error || 'Validation failed') + '</div>'; return; }
        renderValidation(data, raw);
      } catch (e) {
        box.innerHTML = '<div class="result-line result-bad">' + e.message + '</div>';
      }
    });

    function renderValidation(data, raw) {
      const box = document.getElementById('validate-results');
      let html = '<div class="summary"><b>' + data.valid + '</b> valid, <b>' + data.invalid + '</b> invalid of ' + data.total + '</div>';
      data.results.forEach((r, i) => {
        const id = r.scenarioId || ('record ' + (i + 1));
        if (r.valid) html += '<div class="result-line result-ok">✓ ' + id + '</div>';
        else html += '<div class="result-line result-bad">✗ ' + id + ' — ' + r.errors.join('; ') + '</div>';
      });
      box.innerHTML = html;

      // Stash the valid records (reparse client-side using same rules as server intake)
      lastValidRecords = [];
      try {
        let records = [];
        const trimmed = raw.trim();
        try {
          const p = JSON.parse(trimmed);
          records = Array.isArray(p) ? p : (p && Array.isArray(p.scenarios) ? p.scenarios : [p]);
        } catch {
          records = trimmed.split('\\n').map(s => s.trim()).filter(Boolean).map(s => JSON.parse(s));
        }
        lastValidRecords = records.filter((_, i) => data.results[i] && data.results[i].valid);
      } catch { lastValidRecords = []; }

      const submitCard = document.getElementById('submit-card');
      const submitBtn = document.getElementById('btn-submit');
      if (lastValidRecords.length > 0) {
        submitCard.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit ' + lastValidRecords.length + ' valid record' + (lastValidRecords.length === 1 ? '' : 's');
      } else {
        submitBtn.disabled = true;
      }
    }

    document.getElementById('btn-submit').addEventListener('click', async () => {
      const apiBaseUrl = document.getElementById('api-base').value.trim();
      const apiKey = document.getElementById('api-key').value;
      const box = document.getElementById('submit-results');
      box.innerHTML = '<div class="hint">Submitting…</div>';
      try {
        const resp = await fetch('/api/submit', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiBaseUrl, apiKey, records: lastValidRecords }),
        });
        const data = await resp.json();
        if (!resp.ok && !data.serverResponse) { box.innerHTML = '<div class="result-line result-bad">' + (data.error || ('HTTP ' + resp.status)) + '</div>'; return; }
        const sr = data.serverResponse || {};
        let html = '<div class="summary">Server accepted <b>' + (sr.accepted ?? '?') + '</b>, rejected <b>' + (sr.rejected ?? '?') + '</b> (HTTP ' + data.serverStatus + ')</div>';
        (sr.rejectionDetails || []).forEach((rj) => {
          html += '<div class="result-line result-bad">line ' + rj.line + (rj.scenarioId ? ' (' + rj.scenarioId + ')' : '') + ' — ' + rj.reason + '</div>';
        });
        box.innerHTML = html;
      } catch (e) {
        box.innerHTML = '<div class="result-line result-bad">' + e.message + '</div>';
      }
    });

    // Preflight
    async function loadConfig() {
      const box = document.getElementById('config-body');
      try {
        const c = await (await fetch('/api/config')).json();
        document.getElementById('api-base').value = c.suggestedApiBaseUrl || '';
        const pill = (b) => '<span class="pill ' + (b ? 'yes' : 'no') + '">' + (b ? 'set' : 'missing') + '</span>';
        box.innerHTML =
          kv('MAAC server', c.serverUrl) +
          kv('AI endpoint', c.aiEndpoint) +
          kv('AI format', c.aiFormat) +
          kv('AI model', c.aiModel || '—') +
          kv('Timeout', c.timeoutMs + ' ms') +
          kv('Max retries', String(c.maxRetries)) +
          kv('Client API key', pill(c.hasApiKey)) +
          kv('AI auth token', pill(c.hasAiAuthToken)) +
          (c.hasCustomTemplate ? kv('Custom template', pill(true)) : '');
      } catch (e) {
        box.innerHTML = '<div class="result-line result-bad">' + e.message + '</div>';
      }
    }
    function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }

    document.getElementById('btn-preflight').addEventListener('click', async () => {
      const box = document.getElementById('preflight-results');
      box.innerHTML = '<div class="hint">Testing…</div>';
      try {
        const r = await (await fetch('/api/preflight')).json();
        if (r.ok) box.innerHTML = '<div class="result-line result-ok">✓ Reachable — HTTP ' + r.statusCode + ' in ' + r.latencyMs + ' ms</div>';
        else box.innerHTML = '<div class="result-line result-bad">✗ ' + (r.error || ('HTTP ' + r.statusCode)) + ' (' + r.latencyMs + ' ms)</div>';
      } catch (e) {
        box.innerHTML = '<div class="result-line result-bad">' + e.message + '</div>';
      }
    });
  </script>
</body>
</html>`;
