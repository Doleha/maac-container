// WebSocket protocol message types for the MaacVerify Phase 2 assessment tunnel.
// The container is a pure relay — it has no knowledge of MAAC scoring, rubrics,
// or assessment logic. Message types are transport-level only.

// ── Outgoing (container → server) ──────────────────────────────────────────

export type AuthMessage = {
  type: 'AUTH';
  clientApiKey: string;
  containerPublicKey: string; // RSA-2048 public key, PEM format
};

export type ReadyMessage = {
  type: 'READY';
  sessionId: string;
};

export type ResponseMessage = {
  type: 'RESPONSE';
  requestId: string;
  encryptedPayload: string; // AES-256-GCM, base64: nonce(12) || ciphertext || authTag(16)
};

export type ResponseErrorMessage = {
  type: 'RESPONSE_ERROR';
  requestId: string;
  errorCode: string;
  errorMessage: string;
  statusCode: number;
  retriesAttempted: number;
};

export type PongMessage = {
  type: 'PONG';
  scenariosComplete: number;
  scenariosReceived: number;
};

export type DisconnectMessage = { type: 'DISCONNECT' };

// ── Incoming (server → container) ──────────────────────────────────────────

export type SessionInitMessage = {
  type: 'SESSION_INIT';
  sessionKeyEncrypted: string; // AES-256 key encrypted with containerPublicKey, base64
  sessionId: string;
  requestCount: number;
  evaluatorVersion: string;
};

export type SessionResumeMessage = {
  type: 'SESSION_RESUME';
  sessionKeyEncrypted: string;
  sessionId: string;
  requestsComplete: number;
  nextRequestId: string;
};

export type RequestMessage = {
  type: 'REQUEST';
  requestId: string;
  encryptedPayload: string; // AES-256-GCM encrypted SubjectPayload, base64
};

export type SessionCompleteMessage = { type: 'SESSION_COMPLETE' };
export type PingMessage = { type: 'PING' };
export type AuthRejectedMessage = { type: 'AUTH_REJECTED'; reason?: string };
export type SessionAbortMessage = { type: 'SESSION_ABORT'; reason?: string };
export type ReplayDetectedMessage = { type: 'REPLAY_DETECTED' };

export type ServerMessage =
  | SessionInitMessage
  | SessionResumeMessage
  | RequestMessage
  | SessionCompleteMessage
  | PingMessage
  | AuthRejectedMessage
  | SessionAbortMessage
  | ReplayDetectedMessage;

// ── Payload types ───────────────────────────────────────────────────────────

// Decrypted content of a REQUEST message. Task definition fields only.
// successCriteria, expectedCalculations, expectedInsights are never present.
export type SubjectPayload = {
  taskTitle: string;
  taskDescription: string;
  businessContext: string;
  scenarioRequirements: string;
  dataElements: string;
};

// Encrypted into RESPONSE.encryptedPayload
export type ResponsePackage = {
  responseText: string;
  latencyMs: number;
  statusCode: number;
  retriesAttempted: number;
  timestamp: string;
};

// ── Session state ────────────────────────────────────────────────────────────

export type ContainerStatus = 'ready' | 'running' | 'complete' | 'error';

export interface SessionState {
  sessionId: string;
  sessionKey: Buffer;
  requestCount: number;
  scenariosReceived: number;
  scenariosComplete: number;
  retriesTotal: number;
  status: ContainerStatus;
}
