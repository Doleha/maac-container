export type ClientAiFormat = 'openai' | 'anthropic' | 'custom';

export interface Config {
  maacServerUrl: string;
  clientApiKey: string;
  clientAiEndpoint: string;
  clientAiFormat: ClientAiFormat;
  clientAiAuthToken: string;
  clientAiTimeoutMs: number;
  clientAiMaxRetries: number;
  clientAiModel?: string;
  customBodyTemplate?: string;
}

export function loadConfig(): Config {
  const required: Record<string, string | undefined> = {
    MAAC_SERVER_URL: process.env.MAAC_SERVER_URL,
    CLIENT_API_KEY: process.env.CLIENT_API_KEY,
    CLIENT_AI_ENDPOINT: process.env.CLIENT_AI_ENDPOINT,
    CLIENT_AI_FORMAT: process.env.CLIENT_AI_FORMAT,
    CLIENT_AI_AUTH_TOKEN: process.env.CLIENT_AI_AUTH_TOKEN,
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    console.error(`[FATAL] Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  const format = required.CLIENT_AI_FORMAT as string;
  if (!['openai', 'anthropic', 'custom'].includes(format)) {
    console.error(`[FATAL] CLIENT_AI_FORMAT must be one of: openai, anthropic, custom`);
    process.exit(1);
  }

  if (format === 'custom' && !process.env.CUSTOM_BODY_TEMPLATE) {
    console.error(`[FATAL] CUSTOM_BODY_TEMPLATE is required when CLIENT_AI_FORMAT=custom`);
    process.exit(1);
  }

  const timeoutMs = parseInt(process.env.CLIENT_AI_TIMEOUT_MS ?? '120000', 10);
  const maxRetries = parseInt(process.env.CLIENT_AI_MAX_RETRIES ?? '3', 10);

  if (isNaN(timeoutMs) || timeoutMs < 1000) {
    console.error(`[FATAL] CLIENT_AI_TIMEOUT_MS must be a number >= 1000`);
    process.exit(1);
  }
  if (isNaN(maxRetries) || maxRetries < 0) {
    console.error(`[FATAL] CLIENT_AI_MAX_RETRIES must be a non-negative number`);
    process.exit(1);
  }

  return {
    maacServerUrl: required.MAAC_SERVER_URL!,
    clientApiKey: required.CLIENT_API_KEY!,
    clientAiEndpoint: required.CLIENT_AI_ENDPOINT!,
    clientAiFormat: format as ClientAiFormat,
    clientAiAuthToken: required.CLIENT_AI_AUTH_TOKEN!,
    clientAiTimeoutMs: timeoutMs,
    clientAiMaxRetries: maxRetries,
    clientAiModel: process.env.CLIENT_AI_MODEL || undefined,
    customBodyTemplate: process.env.CUSTOM_BODY_TEMPLATE || undefined,
  };
}
