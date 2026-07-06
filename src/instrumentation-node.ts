/**
 * Node.js-only half of instrumentation.ts, loaded via dynamic import behind
 * the NEXT_RUNTIME === "nodejs" guard. Kept in a separate file so the Edge
 * bundle never sees process.exit (Turbopack statically analyzes the whole
 * instrumentation module for every runtime; a runtime guard alone still
 * triggers "Node.js API is not supported in the Edge Runtime" warnings).
 */

import { notifyDiscord } from "@/lib/notify/discord";

/**
 * A failed migration exits the process on purpose: serving with a stale
 * schema is exactly the failure mode this exists to prevent (queries against
 * columns that don't exist yet). Throwing is not enough — Next logs "Failed
 * to prepare server" but keeps the already-bound listener alive, serving 500
 * on every request. exit(1) instead kills the container so the Docker
 * restart policy retries, which also rides out a transiently unready DB.
 */
export async function runBootMigrations() {
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
