/**
 * Next.js instrumentation — boot-time migrations + central server-error
 * reporting.
 *
 * onRequestError fires for every error the Next.js server captures (RSC
 * render failures, unhandled route errors, …). Note: /api/ask catches its
 * own pipeline errors and reports them separately (see route.ts), so this
 * covers everything that would otherwise be an invisible 500.
 */

import type { Instrumentation } from "next";
import { notifyDiscord } from "@/lib/notify/discord";

/**
 * Runs once per server boot, before any request is served — the only hook
 * the standalone Docker image gets, so pending drizzle migrations are
 * applied here. Production only: dev keeps the explicit `pnpm db:migrate`
 * workflow (compose.yml), and a dev boot must not require Postgres to be up.
 *
 * The Node-only implementation (process.exit on failure) lives in
 * instrumentation-node.ts behind this dynamic import, so the Edge bundle
 * never contains Node.js APIs.
 */
export async function register() {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NODE_ENV !== "production"
  ) {
    return;
  }

  const { runBootMigrations } = await import("./instrumentation-node");
  await runBootMigrations();
}

export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  // 404 renders are bot scans and stale service workers probing paths that
  // never existed (/push-sw.js, /wp-login.php, …). Errors thrown while
  // rendering the not-found page are noise, not incidents — a genuine
  // failure (e.g. session backend down) also surfaces on real routes.
  if (context.routePath === "/_not-found") return;

  // err is typed unknown; at runtime it is an Error, possibly with a React
  // digest when it surfaced during Server Components rendering.
  const e = err as Error & { digest?: string };

  // Node runtime: rich pino log (stack, cause chain) + Discord ping with a
  // correlation digest, via the central logger. Dynamic import keeps pino
  // (fs, sonic-boom) out of the Edge bundle.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportError } = await import("@/lib/log/logger");
    reportError(`Serverfel ${request.method} ${request.path}`, err, {
      route: context.routePath,
      routerKind: context.routerKind,
      routeType: context.routeType,
    });
    return;
  }

  // Edge fallback: no filesystem — Discord only, as before.
  await notifyDiscord(
    "alerts",
    [
      `🚨 **Serverfel** \`${request.method} ${request.path}\``,
      `route: ${context.routePath} (${context.routerKind}, ${context.routeType})`,
      `\`\`\`${e.message ?? String(err)}\`\`\``,
      e.digest ? `digest: ${e.digest}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
};
