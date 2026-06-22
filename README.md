# MAAC Container — Client Setup Guide

This container runs inside your environment during a MAAC Phase 2 assessment. It connects to the MaacVerify server over an encrypted WebSocket tunnel, receives assessment scenarios, forwards them to your AI model, and returns the responses. Your model's responses are encrypted before leaving your network and are never readable by MaacVerify in transit.

---

## What You Need Before Starting

Your MaacVerify operator will provide:

- The **WebSocket URL** of the assessment server (e.g. `wss://maacverify.example.com/api/assessment/ws`)
- A **CLIENT_API_KEY** — a single-use session key tied to your specific assessment

You will also need:

- Docker installed on the machine that will run the container
- The HTTP endpoint for your AI model (the one being assessed)
- A bearer token or API key to authenticate requests to your model

---

## Running the Container

### With `docker run`

```bash
docker run --rm \
  -e MAAC_SERVER_URL="wss://provided-by-your-operator" \
  -e CLIENT_API_KEY="provided-by-your-operator" \
  -e CLIENT_AI_ENDPOINT="http://your-model-endpoint/v1/chat/completions" \
  -e CLIENT_AI_FORMAT="openai" \
  -e CLIENT_AI_AUTH_TOKEN="your-model-bearer-token" \
  -e CLIENT_AI_MODEL="your-model-name" \
  -p 8080:8080 \
  maac-container
```

### With Docker Compose

Create a `.env` file — keep this private, it contains your session key:

```env
MAAC_SERVER_URL=wss://provided-by-your-operator
CLIENT_API_KEY=provided-by-your-operator
CLIENT_AI_ENDPOINT=http://your-model-endpoint/v1/chat/completions
CLIENT_AI_FORMAT=openai
CLIENT_AI_AUTH_TOKEN=your-model-bearer-token
CLIENT_AI_MODEL=your-model-name
```

```yaml
# docker-compose.yml
services:
  maac-container:
    image: maac-container
    env_file: .env
    ports:
      - "8080:8080"
    restart: "no"
```

```bash
docker compose up
```

The container exits automatically when the assessment session is complete. Do not set `restart: always` — the `CLIENT_API_KEY` is single-use.

---

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `MAAC_SERVER_URL` | WebSocket URL provided by your operator. Starts with `wss://` for production or `ws://` for local testing. |
| `CLIENT_API_KEY` | Session key provided by your operator. Single-use — cannot be reused once the session completes. |
| `CLIENT_AI_ENDPOINT` | Full URL of your AI model's HTTP endpoint. Must accept `POST` with a JSON body. |
| `CLIENT_AI_FORMAT` | Request format for your model. One of: `openai`, `anthropic`, `custom`. |
| `CLIENT_AI_AUTH_TOKEN` | Bearer token sent as `Authorization: Bearer <token>` on every model request. |

### Optional

| Variable | Default | Description |
|---|---|---|
| `CLIENT_AI_MODEL` | _(not sent)_ | Model identifier included in the request body. Required by most hosted model APIs. |
| `CLIENT_AI_TIMEOUT_MS` | `120000` | Per-request timeout in milliseconds. Increase this if your model is slow to respond. Minimum `1000`. |
| `CLIENT_AI_MAX_RETRIES` | `3` | Number of retry attempts on model errors. Retries use backoff: 2s, 4s, 8s. Set to `0` to disable. |
| `CUSTOM_BODY_TEMPLATE` | _(none)_ | Required when `CLIENT_AI_FORMAT=custom`. See below. |

---

## Choosing CLIENT_AI_FORMAT

### `openai`

Use this for any endpoint compatible with the OpenAI Chat Completions API — including OpenAI, Azure OpenAI, local vLLM, llama.cpp server, and Ollama.

```
CLIENT_AI_FORMAT=openai
CLIENT_AI_ENDPOINT=https://api.openai.com/v1/chat/completions
CLIENT_AI_MODEL=gpt-4o
```

### `anthropic`

Use this for the Anthropic Messages API.

```
CLIENT_AI_FORMAT=anthropic
CLIENT_AI_ENDPOINT=https://api.anthropic.com/v1/messages
CLIENT_AI_MODEL=claude-sonnet-4-6
```

### `custom`

Use this when your endpoint has a non-standard request body. Provide a JSON template with `{{placeholder}}` fields.

Available placeholders:

| Placeholder | Content |
|---|---|
| `{{taskTitle}}` | Short title of the task |
| `{{taskDescription}}` | Full task description |
| `{{businessContext}}` | Background context |
| `{{scenarioRequirements}}` | Requirements the response must address |
| `{{dataElements}}` | Structured data provided with the scenario |

Example:

```
CLIENT_AI_FORMAT=custom
CUSTOM_BODY_TEMPLATE={"input":"{{taskTitle}}\n{{taskDescription}}\n{{businessContext}}","parameters":{"max_new_tokens":2048}}
```

The template must produce valid JSON after placeholder substitution.

---

## Monitoring Progress

The container runs an HTTP health endpoint on port `8080`:

```bash
curl http://localhost:8080/health
```

```json
{
  "status": "running",
  "sessionId": "a1b2c3d4-...",
  "scenariosReceived": 15,
  "scenariosComplete": 12,
  "retriesTotal": 2
}
```

| `status` | Meaning |
|---|---|
| `ready` | Connected, session handshake in progress |
| `running` | Actively processing scenarios |
| `complete` | All scenarios finished, container will exit |
| `error` | Session ended due to an error |

---

## What Happens During a Session

1. The container connects to the MaacVerify server and authenticates with your `CLIENT_API_KEY`.
2. The server sends a session key, encrypted with an RSA public key generated by the container. Only the container can decrypt it.
3. Each scenario arrives as an encrypted payload. The container decrypts it, formats a prompt, and sends it to your model.
4. The model's response is encrypted with the session key before being sent back. MaacVerify receives the encrypted blob — not the raw text.
5. This repeats until all scenarios are complete. The container then disconnects and exits.

---

## If the Connection Drops

The container will attempt to reconnect up to 3 times, waiting 5 seconds between attempts. If it reconnects within 5 minutes of the disconnect, the session resumes from the last completed scenario — nothing is re-run.

If the 5-minute window expires, the session is aborted and a new assessment session must be created by your operator.

---

## Common Errors

**`[FATAL] Missing required environment variables: ...`**
One or more required variables are missing. Check that all five are set and non-empty.

**`AUTH_REJECTED: Invalid credentials`**
The `CLIENT_API_KEY` is incorrect, has already been used in a completed session, or was issued for a different endpoint. Contact your operator.

**`AUTH_REJECTED: Session is closed`**
This session already ran to completion or was manually closed. A new session key is needed.

**`AUTH_REJECTED: Duplicate connection`**
Another instance of the container is already connected using the same key. Stop the other instance first.

**`[relay] Client AI returned 401`**
The `CLIENT_AI_AUTH_TOKEN` is being rejected by your model endpoint. Verify the token is correct.

**`[relay] Client AI returned 404`**
The `CLIENT_AI_ENDPOINT` URL is unreachable or incorrect. Confirm the model service is running and the URL is right.

**`scenariosComplete` not increasing**
The container is receiving scenarios but your model is returning errors. Check the container logs for `[relay]` lines to see what error code is coming back from your endpoint.

---

## Security

- The container's RSA private key exists only in memory and is zeroed immediately after the session key is decrypted. It is never written to disk or logged.
- The session key is generated fresh for each connection and lives only in memory.
- No scenario content, prompts, or model responses are written to disk at any point.
- The container runs as a non-root user.
- The `CLIENT_API_KEY` is never logged.

---

## Building from Source

```bash
npm ci
npm run build
docker build -t maac-container .
```
