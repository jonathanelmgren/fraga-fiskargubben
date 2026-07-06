/**
 * Programmatic migration runner — applies ./drizzle at server boot.
 *
 * Called from instrumentation.ts register() so the production container
 * migrates itself before serving traffic. The deploy pipeline has no other
 * migration step: CI's `pnpm db:migrate` only targets the ephemeral test
 * database, and the standalone runtime image ships neither drizzle-kit nor
 * devDependencies, so the drizzle-orm migrator (already traced into the
 * bundle via the app's own drizzle-orm usage) is the one tool available.
 *
 * Uses a dedicated single connection instead of the app pool in client.ts:
 * the migrator wraps everything in one transaction and must not interleave
 * with app queries; the connection is closed as soon as migrations finish.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { env } from "@/shared/env";

export async function runMigrations(): Promise<void> {
  const migrationClient = postgres(env.DATABASE_URL, { max: 1 });
  try {
    // Relative to cwd: repo root under `next start`, /app in the standalone
    // image (Dockerfile copies the folder there).
    await migrate(drizzle(migrationClient), { migrationsFolder: "./drizzle" });
  } finally {
    await migrationClient.end();
  }
}
