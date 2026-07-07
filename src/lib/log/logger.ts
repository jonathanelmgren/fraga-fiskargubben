/**
 * Central pino logger — structured logs to stdout AND a logfile, plus a
 * digest-correlated Discord alert channel for errors that need an ops ping.
 *
 * Design:
 *  - pino.multistream (NOT pino transports): transports spawn worker threads
 *    that resolve module paths at runtime — brittle in the Next standalone
 *    bundle. multistream writes in-process; pino is on Next's
 *    server-external-packages list so it is never bundled.
 *  - File stream is sync (sonic-boom sync:true) so a process.exit(1) right
 *    after a log call (boot-migration failure) cannot lose the line.
 *  - Every reportError() gets a short random digest. The Discord alert shows
 *    only message + digest; the full serialized error (stack, cause chain,
 *    upstream status, context) lives in the logfile/stdout. Grep the digest:
 *      grep <digest> logs/app.log | jq
 *  - Reads process.env directly (not @/shared/env) so instrumentation can
 *    import it in any runtime without dragging in the env schema.
 *
 * Env:
 *  - LOG_DIR   — directory for app.log. Default: "logs" in production,
 *                no file logging otherwise (dev/test = stdout only).
 *  - LOG_LEVEL — pino level, default "info" ("silent" to mute in tests).
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import pino from "pino";
import { notifyDiscord } from "@/lib/notify/discord";

export type LogContext = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Logger singleton — lazy so importing this module has no filesystem
// side-effects (tests import call sites without wanting a logs/ dir).
// ---------------------------------------------------------------------------

let _logger: pino.Logger | undefined;

function buildLogger(): pino.Logger {
  const level = process.env.LOG_LEVEL ?? "info";

  const streams: pino.StreamEntry[] = [
    { level: "trace", stream: process.stdout },
  ];

  const logDir =
    process.env.LOG_DIR ??
    (process.env.NODE_ENV === "production" ? "logs" : undefined);
  if (logDir) {
    streams.push({
      level: "trace",
      // sync + mkdir: survive an immediate process.exit and a fresh volume.
      stream: pino.destination({
        dest: path.join(logDir, "app.log"),
        mkdir: true,
        sync: true,
      }),
    });
  }

  return pino(
    {
      level,
      // No pid/hostname noise — one container, one process.
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams, { dedupe: false }),
  );
}

export function getLogger(): pino.Logger {
  _logger ??= buildLogger();
  return _logger;
}

/** Test hook: drop the singleton so env changes take effect. */
export function resetLoggerForTests(): void {
  _logger = undefined;
}

// ---------------------------------------------------------------------------
// Error serialization — keep the whole cause chain + typed-error fields
// ---------------------------------------------------------------------------

const MAX_CAUSE_DEPTH = 5;

/**
 * Serialize an error with everything the Discord one-liner drops: stack,
 * recursive cause chain, and the typed fields our ExternalServiceError /
 * TimeoutError carry (status, service) plus React server digests.
 */
export function serializeError(
  err: unknown,
  depth = 0,
): Record<string, unknown> | string {
  if (!(err instanceof Error)) {
    return typeof err === "string" ? err : JSON.stringify(err);
  }
  const e = err as Error & {
    status?: unknown;
    service?: unknown;
    digest?: unknown;
  };
  return {
    name: e.name,
    message: e.message,
    stack: e.stack,
    ...(e.status !== undefined ? { status: e.status } : {}),
    ...(e.service !== undefined ? { service: e.service } : {}),
    ...(e.digest !== undefined ? { reactDigest: e.digest } : {}),
    ...(e.cause !== undefined && depth < MAX_CAUSE_DEPTH
      ? { cause: serializeError(e.cause, depth + 1) }
      : {}),
  };
}

/** Short correlation id linking a Discord alert to its logfile entry. */
export function newDigest(): string {
  return randomBytes(4).toString("hex");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Warning: logfile + stdout only (no Discord — warnings would spam it). */
export function logWarn(
  scope: string,
  message: string,
  context?: LogContext,
): void {
  getLogger().warn({ scope, ...context }, `${scope}: ${message}`);
}

/**
 * Error to logfile + stdout with full serialization. No Discord ping — use
 * reportError for that. Returns the digest for callers that alert themselves
 * (e.g. the boot-migration path, which must AWAIT its Discord send before
 * process.exit).
 */
export function logError(
  scope: string,
  err: unknown,
  context?: LogContext,
): string {
  const digest = newDigest();
  getLogger().error(
    { scope, digest, ...context, err: serializeError(err) },
    `${scope}: ${messageOf(err)}`,
  );
  return digest;
}

/**
 * Error to logfile + stdout AND a fire-and-forget Discord alert carrying the
 * digest. The alert stays short; the digest makes the rich entry queryable:
 * grep it in the logfile for stack, cause chain, upstream status and context.
 */
export function reportError(
  scope: string,
  err: unknown,
  context?: LogContext,
): string {
  const digest = logError(scope, err, context);
  void notifyDiscord(
    "alerts",
    [
      `🚨 **${scope}**`,
      `\`\`\`${messageOf(err)}\`\`\``,
      `digest: \`${digest}\``,
    ].join("\n"),
  ).catch(() => {});
  return digest;
}
