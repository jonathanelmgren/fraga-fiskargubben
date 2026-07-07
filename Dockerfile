FROM node:24-alpine AS base
RUN corepack enable

FROM base AS builder
WORKDIR /app

# NEXT_PUBLIC_* vars are inlined into the client bundle at `next build` —
# runtime env (docker run --env-file) can NOT supply them. They must be real
# here. Values are public by definition (shipped to every browser), so
# defaults live in the image; override with --build-arg if they change.
ARG NEXT_PUBLIC_DISCORD_INVITE=https://discord.gg/aHSzgGhWyh
ARG NEXT_PUBLIC_MICROSOFT_ENABLED=false
ENV NEXT_PUBLIC_DISCORD_INVITE=$NEXT_PUBLIC_DISCORD_INVITE \
    NEXT_PUBLIC_MICROSOFT_ENABLED=$NEXT_PUBLIC_MICROSOFT_ENABLED

# Build-time placeholders only. env.ts validates at import and `next build`
# imports it during page-data collection. These dummies satisfy validation;
# the real (server-side) values are injected at runtime via
# `docker run --env-file`. No secret is baked into the image.
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
    HOSTNAME=0.0.0.0 \
    LOG_DIR=/app/logs

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# SQL migrations + journal, applied at boot by instrumentation.ts register()
# (the standalone bundle has the drizzle-orm migrator but reads these via fs).
COPY --from=builder /app/drizzle ./drizzle

# The next/image optimizer writes to .next/cache at runtime. Everything else
# under /app stays root-owned read-only on purpose — only the cache dir needs
# to be writable by the runtime user.
RUN mkdir -p /app/.next/cache && chown -R nextjs:nodejs /app/.next/cache

# pino logfile (LOG_DIR). Mount a host volume here (-v .../logs:/app/logs) so
# app.log survives container recreation and is greppable from the host.
RUN mkdir -p /app/logs && chown nextjs:nodejs /app/logs

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
