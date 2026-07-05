/**
 * POST /api/preferences — persist small account-level preferences.
 *
 * Body: { shareLocation?: boolean, tosAccepted?: true }
 *
 * Used by the chat UI to store the "Använd min plats" toggle and the terms
 * acceptance on the account, including the one-time transfer of an anon
 * user's localStorage values after registration/login. Session required —
 * anon users keep these in localStorage only.
 */

import "server-only";

import { eq } from "drizzle-orm";
import { emit } from "@/lib/analytics/events";
import { getSession } from "@/lib/get-session";
import { TOS_VERSION } from "@/lib/tos-version";
import { db } from "@/shared/db/client";
import { users } from "@/shared/db/schema";
import { env } from "@/shared/env";
import { isSameOriginRequest } from "../ask/route";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers, env.BETTER_AUTH_URL)) {
    return Response.json({ error: "cross-origin" }, { status: 403 });
  }

  const session = await getSession();
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  const { shareLocation, tosAccepted } = body as {
    shareLocation?: unknown;
    tosAccepted?: unknown;
  };

  const patch: Partial<{
    shareLocation: boolean;
    tosAcceptedAt: Date;
    tosAcceptedVersion: number;
  }> = {};
  if (typeof shareLocation === "boolean") {
    patch.shareLocation = shareLocation;
  }
  // Acceptance is one-way and versioned: the timestamp records WHEN, the
  // version records WHAT was accepted (a later TOS_VERSION re-prompts).
  if (tosAccepted === true) {
    patch.tosAcceptedAt = new Date();
    patch.tosAcceptedVersion = TOS_VERSION;
  }
  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "nothing to update" }, { status: 400 });
  }

  await db.update(users).set(patch).where(eq(users.id, session.user.id));
  if (patch.tosAcceptedAt) {
    void emit({ type: "tos_accepted" });
  }
  return Response.json({ ok: true });
}
