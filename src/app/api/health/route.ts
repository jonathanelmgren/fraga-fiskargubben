import { sql } from "drizzle-orm";
import { db } from "@/shared/db/client";

/**
 * Liveness/readiness probe for the VPS runner (docker healthcheck / uptime
 * monitoring). 200 when the app can reach Postgres, 503 otherwise. No auth —
 * response carries no data beyond up/down.
 */
export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "db_unreachable" }, { status: 503 });
  }
}
