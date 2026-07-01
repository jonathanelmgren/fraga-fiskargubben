/**
 * GC job: delete unclaimed anonymous conversation rows older than a TTL.
 *
 * Run:  pnpm tsx scripts/gc-anon.ts
 *
 * M12: `gcUnclaimedAnon` (src/lib/chat/anon.ts) was documented + tested but the
 * referenced `scripts/gc-anon.ts` did not exist, so unclaimed anon rows (each
 * holding a frozen Signals snapshot jsonb) accumulated forever.  This is that
 * script.  Scheduling it (cron / platform scheduler) is left to the operator —
 * [~] deferred: GC scheduling infra.
 *
 * Note: this script issues the delete directly (mirroring the ETL scripts'
 * lazy-db pattern) rather than importing `gcUnclaimedAnon`, because anon.ts
 * has `import "server-only"` which throws when imported into a plain Node/tsx
 * process.  The query is identical to gcUnclaimedAnon (the tested source of
 * truth): DELETE WHERE userId IS NULL AND lastActiveAt < cutoff.
 *
 * TTL: rows with userId IS NULL that have been INACTIVE since before
 * (now − TTL_DAYS) are deleted — filtering on lastActiveAt (maintained per
 * turn by /api/ask) so an actively-used anon conversation is not purged.
 */

const TTL_DAYS = Number(process.env.ANON_GC_TTL_DAYS ?? "7");

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(1);
  }

  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { default: postgres } = await import("postgres");
  const { and, isNull, lt } = await import("drizzle-orm");
  const { conversations } = await import("@/shared/db/schema");

  const pg = postgres(databaseUrl);
  const db = drizzle(pg);

  const cutoff = new Date(Date.now() - TTL_DAYS * 86_400_000);
  const deleted = await db
    .delete(conversations)
    .where(
      and(isNull(conversations.userId), lt(conversations.lastActiveAt, cutoff)),
    )
    .returning({ id: conversations.id });

  const count = deleted.length;
  console.log(
    `GC'd ${count} unclaimed anon conversation row(s) older than ${TTL_DAYS}d (cutoff ${cutoff.toISOString()}).`,
  );

  await pg.end();
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("gc-anon.ts") ||
    process.argv[1].endsWith("gc-anon.js"));

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
