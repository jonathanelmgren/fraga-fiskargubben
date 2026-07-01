/**
 * H12: shared lazy single-row-by-lakeId lookup.
 *
 * colour.ts / depth.ts / species.ts / temp.ts all repeated the verbatim
 * lazy-import-db + `select(cols).from(table).where(eq(table.lakeId, id))
 * .limit(1)` + `rows[0] ?? null` skeleton.  This collapses that into one
 * helper.  The lazy `db` import is preserved here so the water lookups stay
 * out of pure-unit-test scope (no DB/server-only at import time).
 */

import "server-only";

// biome-ignore lint/suspicious/noExplicitAny: generic drizzle column/table shapes
type AnyTable = any;

/**
 * Select a single row from `table` where its `lakeId` column equals `lakeId`,
 * projecting only `columns`.  Returns the row or `null` when none exists.
 */
export async function selectOneByLakeId<TCols extends Record<string, unknown>>(
  table: AnyTable,
  lakeIdColumn: AnyTable,
  columns: TCols,
  lakeId: string,
): Promise<{ [K in keyof TCols]: unknown } | null> {
  const { db } = await import("@/shared/db/client");
  const { eq } = await import("drizzle-orm");

  const rows = await db
    .select(columns as Record<string, AnyTable>)
    .from(table)
    .where(eq(lakeIdColumn, lakeId))
    .limit(1);

  return (rows[0] as { [K in keyof TCols]: unknown } | undefined) ?? null;
}
