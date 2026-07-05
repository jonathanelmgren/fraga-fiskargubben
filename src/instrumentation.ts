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
 * A failed migration exits the process on purpose: serving with a stale
 * schema is exactly the failure mode this exists to prevent (queries against
 * columns that don't exist yet). Throwing is not enough — Next logs "Failed
 * to prepare server" but keeps the already-bound listener alive, serving 500
 * on every request. exit(1) instead kills the container so the Docker
 * restart policy retries, which also rides out a transiently unready DB.
 */
export async function register() {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NODE_ENV !== "production"
  ) {
    return;
  }

  const { runMigrations } = await import("@/shared/db/migrate");
  try {
    await runMigrations();
    console.log("[instrumentation] drizzle migrations applied");
  } catch (err) {
    console.error("[instrumentation] migration failed, exiting", err);
    await notifyDiscord(
      "alerts",
      [
        "🚨 **Migrations misslyckades vid serverstart** — servern startar inte",
        `\`\`\`${err instanceof Error ? err.message : String(err)}\`\`\``,
      ].join("\n"),
    );
    process.exit(1);
  }
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
