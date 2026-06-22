import { Config } from './config.js';
import { SubjectPayload, ResponsePackage } from './types.js';

const BACKOFF_MS = [2000, 4000, 8000] as const;

// Renders a SubjectPayload into a labelled-section prompt string.
function renderPrompt(payload: SubjectPayload): string {
  return [
    `Task Title: ${payload.taskTitle}`,
    ``,
    `Task Description:\n${payload.taskDescription}`,
    ``,
    `Business Context:\n${payload.businessContext}`,
    ``,
    `Scenario Requirements:\n${payload.scenarioRequirements}`,
    ``,
    `Data Elements:\n${payload.dataElements}`,
  ].join('\n');
}

// Interpolates {{field}} placeholders in CUSTOM_BODY_TEMPLATE.
function interpolateTemplate(template: string, payload: SubjectPayload): Record<string, unknown> {
  const rendered = template
    .replace(/\{\{taskTitle\}\}/g, payload.taskTitle)
    .replace(/\{\{taskDescription\}\}/g, payload.taskDescription)
    .replace(/\{\{businessContext\}\}/g, payload.businessContext)
    .replace(/\{\{scenarioRequirements\}\}/g, payload.scenarioRequirements)
    .replace(/\{\{dataElements\}\}/g, payload.dataElements);
  try {
    return JSON.parse(rendered) as Record<string, unknown>;
  } catch {
    throw new Error('CUSTOM_BODY_TEMPLATE produced invalid JSON after interpolation');
  }
}

function buildRequestBody(prompt: string, payload: SubjectPayload, config: Config): Record<string, unknown> {
  if (config.clientAiFormat === 'openai') {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: prompt }],
    };
    if (config.clientAiModel) body.model = config.clientAiModel;
    return body;
  }

  if (config.clientAiFormat === 'anthropic') {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    };
    if (config.clientAiModel) body.model = config.clientAiModel;
    return body;
  }

  // custom — interpolate template with individual payload fields
  return interpolateTemplate(config.customBodyTemplate!, payload);
}

function extractResponseText(data: unknown, format: Config['clientAiFormat']): string {
  if (format === 'openai') {
    const d = data as { choices?: Array<{ message?: { content?: string }; text?: string }> };
    return d.choices?.[0]?.message?.content ?? d.choices?.[0]?.text ?? JSON.stringify(data);
  }
  if (format === 'anthropic') {
    const d = data as { content?: Array<{ type: string; text?: string }> };
    return d.content?.find(c => c.type === 'text')?.text ?? JSON.stringify(data);
  }
  return JSON.stringify(data);
}

interface RelayError extends Error {
  retryable: boolean;
  statusCode?: number;
  errorCode: string;
}

function makeRelayError(message: string, retryable: boolean, statusCode?: number, errorCode?: string): RelayError {
  const err = new Error(message) as RelayError;
  err.retryable = retryable;
  err.statusCode = statusCode;
  err.errorCode = errorCode ?? 'CLIENT_AI_ERROR';
  return err;
}

export async function executeRequest(
  payload: SubjectPayload,
  config: Config,
): Promise<ResponsePackage> {
  const prompt = renderPrompt(payload);
  const body = buildRequestBody(prompt, payload, config);

  let lastError: RelayError | null = null;
  let lastStatusCode = 0;
  let retriesAttempted = 0;
  const startMs = Date.now();

  for (let attempt = 0; attempt <= config.clientAiMaxRetries; attempt++) {
    if (attempt > 0) {
      retriesAttempted = attempt;
      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), config.clientAiTimeoutMs);

    try {
      const res = await fetch(config.clientAiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.clientAiAuthToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutHandle);
      lastStatusCode = res.status;

      if (res.status >= 400 && res.status < 500) {
        // 4xx — non-retryable
        throw makeRelayError(
          `Client AI returned ${res.status}`,
          false,
          res.status,
          'CLIENT_AI_ERROR',
        );
      }

      if (!res.ok) {
        // 5xx — retryable
        lastError = makeRelayError(
          `Client AI returned ${res.status}`,
          true,
          res.status,
          'CLIENT_AI_SERVER_ERROR',
        );
        continue;
      }

      const data: unknown = await res.json();
      const responseText = extractResponseText(data, config.clientAiFormat);
      const latencyMs = Date.now() - startMs;

      return {
        responseText,
        latencyMs,
        statusCode: res.status,
        retriesAttempted,
        timestamp: new Date().toISOString(),
      };
    } catch (err: unknown) {
      clearTimeout(timeoutHandle);
      const e = err as RelayError;

      if (e.retryable === false) throw e;

      if ((err as Error).name === 'AbortError') {
        lastError = makeRelayError('Client AI request timed out', true, 0, 'CLIENT_AI_TIMEOUT');
        continue;
      }

      // Network error — retryable
      lastError = makeRelayError(
        (err as Error).message ?? 'Network error',
        true,
        0,
        'CLIENT_AI_NETWORK_ERROR',
      );
    }
  }

  throw lastError ?? makeRelayError('All retries exhausted', false, lastStatusCode, 'CLIENT_AI_ERROR');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
