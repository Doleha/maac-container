# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /build

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled output
COPY --from=builder /build/dist ./dist

# Published scenario schema (served at /api/schema and usable by client tooling)
COPY schema/ ./schema/

# Health + UI endpoint
EXPOSE 8080

# No volumes, no persistent storage, no scenario data written to disk
USER node

CMD ["node", "dist/index.js"]
