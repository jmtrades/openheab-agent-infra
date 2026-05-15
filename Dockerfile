# ============================================================================
# OpenHeab Substrate — production Dockerfile
# 189 primitives, 1,495 routes, Apache-2.0, self-hostable.
# ============================================================================
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++ openssl curl

# ---- deps stage (cacheable layer) ------------------------------------------
FROM base AS deps
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---- runtime stage ---------------------------------------------------------
FROM base
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Refuse to start without DATABASE_URL (loud failure rather than crash loop)
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
  CMD curl -fsS http://localhost:3000/healthz || exit 1

CMD ["node", "server.js"]
