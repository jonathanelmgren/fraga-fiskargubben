/**
 * Next.js instrumentation — central server-error reporting.
 *
 * onRequestError fires for every error the Next.js server captures (RSC
 * render failures, unhandled route errors, …). Note: /api/ask catches its
 * own pipeline errors and reports them separately (see route.ts), so this
 * covers everything that would otherwise be an invisible 500.
 */

import type { Instrumentation } from "next";
import { notifyDiscord } from "@/lib/notify/discord";

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
