import WebSocket from 'ws';
import { Config } from './config.js';
import {
  ServerMessage,
  SessionInitMessage,
  SessionResumeMessage,
  SessionState,
  SubjectPayload,
  ResponsePackage,
} from './types.js';
import {
  generateRsaKeyPair,
  decryptSessionKey,
  zeroBuffer,
  encryptWithSessionKey,
  decryptWithSessionKey,
} from './crypto.js';
import { executeRequest } from './relay.js';

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 5000;
const AUTH_TIMEOUT_MS = 30_000;

type SessionResult = 'complete' | 'disconnected' | 'auth_rejected' | 'aborted';

export async function runTunnel(
  config: Config,
  onStateChange: (state: SessionState | null) => void,
): Promise<void> {
  let priorState: SessionState | null = null;

  for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      console.log(`[tunnel] Reconnecting (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS - 1})...`);
      await sleep(RECONNECT_DELAY_MS);
    }

    const { result, finalState } = await runSession(config, onStateChange, attempt > 0, priorState);
    priorState = finalState;

    if (result === 'complete') return;

    if (result === 'auth_rejected') {
      console.error('[tunnel] AUTH rejected by server — exiting');
      process.exit(1);
    }

    if (result === 'aborted') {
      console.error('[tunnel] Session aborted by server — exiting');
      process.exit(1);
    }

    console.warn('[tunnel] Disconnected unexpectedly');
  }

  console.error(`[tunnel] Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts — exiting`);
  process.exit(1);
}

async function runSession(
  config: Config,
  onStateChange: (state: SessionState | null) => void,
  isReconnect: boolean,
  priorState: SessionState | null,
): Promise<{ result: SessionResult; finalState: SessionState | null }> {
  // Generate fresh RSA keypair for this connection attempt
  const { publicKeyPem, privateKeyDer } = generateRsaKeyPair();

  let sessionState: SessionState | null = null;

  // ── Message queue ─────────────────────────────────────────────────────────
  // null signals disconnection; PING handled inline without queuing
  const queue: Array<ServerMessage | null> = [];
  const waiters: Array<(msg: ServerMessage | null) => void> = [];

  function enqueue(msg: ServerMessage | null): void {
    if (waiters.length > 0) {
      waiters.shift()!(msg);
    } else {
      queue.push(msg);
    }
  }

  function nextMessage(): Promise<ServerMessage | null> {
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    return new Promise(resolve => waiters.push(resolve));
  }

  // ── Connect ───────────────────────────────────────────────────────────────
  const ws = new WebSocket(config.maacServerUrl);

  ws.on('message', (data) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data.toString()) as ServerMessage;
    } catch {
      return; // ignore malformed frames
    }

    if (msg.type === 'PING') {
      ws.send(JSON.stringify({
        type: 'PONG',
        scenariosComplete: sessionState?.scenariosComplete ?? 0,
        scenariosReceived: sessionState?.scenariosReceived ?? 0,
      }));
      return;
    }

    enqueue(msg);
  });

  ws.on('close', () => enqueue(null));
  ws.on('error', (err) => {
    console.error('[tunnel] WebSocket error:', err.message);
    enqueue(null);
  });

  const ret = (result: SessionResult): { result: SessionResult; finalState: SessionState | null } =>
    ({ result, finalState: sessionState });

  try {
    await waitForOpen(ws);
  } catch {
    zeroBuffer(privateKeyDer);
    return ret('disconnected');
  }

  send(ws, {
    type: 'AUTH',
    clientApiKey: config.clientApiKey,
    containerPublicKey: publicKeyPem,
  });

  // ── AUTH handshake ────────────────────────────────────────────────────────
  const initMsg = await Promise.race([
    nextMessage(),
    sleep(AUTH_TIMEOUT_MS).then(() => 'timeout' as const),
  ]);

  if (initMsg === 'timeout') {
    console.error('[tunnel] Timed out waiting for SESSION_INIT');
    zeroBuffer(privateKeyDer);
    ws.terminate();
    return ret('disconnected');
  }

  if (initMsg === null) {
    zeroBuffer(privateKeyDer);
    return ret('disconnected');
  }

  if (initMsg.type === 'AUTH_REJECTED') {
    zeroBuffer(privateKeyDer);
    return ret('auth_rejected');
  }

  if (initMsg.type !== 'SESSION_INIT' && initMsg.type !== 'SESSION_RESUME') {
    console.error(`[tunnel] Unexpected message type during handshake: ${initMsg.type}`);
    zeroBuffer(privateKeyDer);
    ws.terminate();
    return ret('disconnected');
  }

  // Decrypt session key, immediately zero RSA private key.
  // Guards above ensure initMsg is SESSION_INIT | SESSION_RESUME; cast for TS.
  const sessionMsg = initMsg as SessionInitMessage | SessionResumeMessage;

  let sessionKey: Buffer;
  try {
    sessionKey = decryptSessionKey(sessionMsg.sessionKeyEncrypted, privateKeyDer);
  } catch (err) {
    console.error('[tunnel] Failed to decrypt session key:', (err as Error).message);
    zeroBuffer(privateKeyDer);
    ws.terminate();
    return ret('disconnected');
  } finally {
    zeroBuffer(privateKeyDer);
  }

  const sessionId = sessionMsg.sessionId;
  const priorRequestCount: number = priorState !== null ? priorState.requestCount : 0;
  const requestCount: number = sessionMsg.type === 'SESSION_INIT' ? sessionMsg.requestCount : priorRequestCount;

  console.log(`[tunnel] Session ${sessionId} ${isReconnect ? 'resumed' : 'started'} — ${requestCount} scenarios`);
  if (sessionMsg.type === 'SESSION_INIT') {
    console.log(`[tunnel] Evaluator version: ${sessionMsg.evaluatorVersion}`);
  }

  sessionState = {
    sessionId,
    sessionKey,
    requestCount,
    scenariosReceived: sessionMsg.type === 'SESSION_RESUME' ? sessionMsg.requestsComplete : 0,
    scenariosComplete: sessionMsg.type === 'SESSION_RESUME' ? sessionMsg.requestsComplete : 0,
    retriesTotal: 0,
    status: 'running',
  };
  onStateChange(sessionState);

  send(ws, { type: 'READY', sessionId });

  // ── Request execution loop ────────────────────────────────────────────────
  while (true) {
    const msg = await nextMessage();

    if (msg === null) {
      zeroBuffer(sessionKey);
      return ret('disconnected');
    }

    if (msg.type === 'SESSION_COMPLETE') {
      send(ws, { type: 'DISCONNECT' });
      sessionState.status = 'complete';
      onStateChange(sessionState);
      zeroBuffer(sessionKey);
      ws.close();
      return ret('complete');
    }

    if (msg.type === 'SESSION_ABORT') {
      console.error(`[tunnel] Session aborted by server: ${msg.reason ?? 'no reason given'}`);
      sessionState.status = 'error';
      onStateChange(sessionState);
      zeroBuffer(sessionKey);
      ws.close();
      return ret('aborted');
    }

    if (msg.type === 'REPLAY_DETECTED') {
      console.error('[tunnel] Server detected a replayed nonce — session terminated');
      sessionState.status = 'error';
      onStateChange(sessionState);
      zeroBuffer(sessionKey);
      ws.close();
      return ret('aborted');
    }

    if (msg.type !== 'REQUEST') {
      console.warn(`[tunnel] Unexpected message type in request loop: ${msg.type}`);
      continue;
    }

    sessionState.scenariosReceived++;
    onStateChange(sessionState);

    await handleRequest(ws, msg.requestId, msg.encryptedPayload, sessionKey, sessionState, config);

    onStateChange(sessionState);
  }
}

async function handleRequest(
  ws: WebSocket,
  requestId: string,
  encryptedPayload: string,
  sessionKey: Buffer,
  state: SessionState,
  config: Config,
): Promise<void> {
  let payloadBuf: Buffer;
  try {
    payloadBuf = decryptWithSessionKey(encryptedPayload, sessionKey);
  } catch (err) {
    console.error(`[relay] Failed to decrypt payload for ${requestId}:`, (err as Error).message);
    send(ws, {
      type: 'RESPONSE_ERROR',
      requestId,
      errorCode: 'DECRYPT_FAILED',
      errorMessage: 'Failed to decrypt request payload',
      statusCode: 0,
      retriesAttempted: 0,
    });
    return;
  }

  let payload: SubjectPayload;
  try {
    payload = JSON.parse(payloadBuf.toString('utf-8')) as SubjectPayload;
  } catch {
    send(ws, {
      type: 'RESPONSE_ERROR',
      requestId,
      errorCode: 'INVALID_PAYLOAD',
      errorMessage: 'Request payload is not valid JSON',
      statusCode: 0,
      retriesAttempted: 0,
    });
    return;
  } finally {
    zeroBuffer(payloadBuf); // zero decrypted content as soon as it's parsed
  }

  let responsePackage: ResponsePackage;
  try {
    responsePackage = await executeRequest(payload, config);
    state.retriesTotal += responsePackage.retriesAttempted;
  } catch (err: unknown) {
    const e = err as { errorCode?: string; message?: string; statusCode?: number; retriesAttempted?: number };
    console.error(`[relay] Request ${requestId} failed:`, e.message);
    send(ws, {
      type: 'RESPONSE_ERROR',
      requestId,
      errorCode: e.errorCode ?? 'CLIENT_AI_ERROR',
      errorMessage: e.message ?? 'Unknown error',
      statusCode: e.statusCode ?? 0,
      retriesAttempted: e.retriesAttempted ?? config.clientAiMaxRetries,
    });
    return;
  }

  // Encrypt response package and send; zero response text from our reference
  const responseJson = JSON.stringify(responsePackage);
  const encryptedResponse = encryptWithSessionKey(Buffer.from(responseJson, 'utf-8'), sessionKey);

  // Zero the plaintext response string (best-effort in JS)
  responsePackage.responseText = '';

  send(ws, { type: 'RESPONSE', requestId, encryptedPayload: encryptedResponse });

  state.scenariosComplete++;
  console.log(`[tunnel] ${state.scenariosComplete}/${state.requestCount} scenarios complete`);
}

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('close', () => reject(new Error('WebSocket closed before open')));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
