FROM node:24-alpine AS base
RUN corepack enable

FROM base AS builder
WORKDIR /app

# Build-time placeholders only. env.ts validates at import and `next build`
# imports it during page-data collection. These dummies satisfy validation;
# the real values are injected at runtime via `docker run --env-file`. No
# secret is baked into the image.
ENV DATABASE_URL=postgres://build:build@localhost:5432/build \
    BETTER_AUTH_SECRET=build-time-placeholder-secret-32-bytes-long \
    BETTER_AUTH_URL=http://localhost:3000 \
    GOOGLE_CLIENT_ID=build \
    GOOGLE_CLIENT_SECRET=build \
    MICROSOFT_CLIENT_ID=build \
    MICROSOFT_CLIENT_SECRET=build \
    ANTHROPIC_API_KEY=build \
    LM_ORDER_ID=build \
    LM_USERNAME=build \
    LM_PASSWORD=build \
    ADMIN_EMAILS=build \
    NEXT_TELEMETRY_DISABLED=1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --ignore-scripts: skip the `prepare` hook (lefthook install needs git, which
# isn't in the image and isn't needed for a prod build).
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# SQL migrations + journal, applied at boot by instrumentation.ts register()
# (the standalone bundle has the drizzle-orm migrator but reads these via fs).
COPY --from=builder /app/drizzle ./drizzle

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
