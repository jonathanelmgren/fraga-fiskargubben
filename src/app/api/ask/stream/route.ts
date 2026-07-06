/**
 * GET /api/ask/stream — re-attach to an in-flight (or grace-window) advice
 * stream after a client disconnect (resumable-chat-streams design spec).
 *
 * Query: `conversationId` (UUID) + `offset` (UTF-16 code units already
 * rendered client-side, default 0). The body replays `text.slice(offset)`
 * from the stream registry and continues live until generation settles.
 *
 * Ownership mirrors loadConversationView (C1): the logged-in owner OR an anon
 * caller whose HMAC-verified fiska_claim cookie matches the row. Unknown,
 * foreign and inactive conversations all 404 without revealing existence.
 * Read-only, cookie-authed GET — the same-origin policy prevents cross-site
 * reads, so no CSRF guard is needed (unlike POST /api/ask).
 */

import "server-only";

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { verifyClaimToken } from "@/lib/chat/claim-cookie";
import { subscribe } from "@/lib/chat/stream-registry";
import { getSession } from "@/lib/get-session";
import { db } from "@/shared/db/client";
import { conversations } from "@/shared/db/schema";

const CLAIM_TOKEN_COOKIE = "fiska_claim";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId");
  if (!conversationId || !UUID_RE.test(conversationId)) {
    return Response.json({ error: "invalid conversationId" }, { status: 400 });
  }
  const rawOffset = Number(url.searchParams.get("offset") ?? "0");
  const offset =
    Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const session = await getSession();
  const cookieStore = await cookies();
  const claimToken = verifyClaimToken(
    cookieStore.get(CLAIM_TOKEN_COOKIE)?.value,
  );

  const rows = await db
    .select({
      userId: conversations.userId,
      claimToken: conversations.claimToken,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const row = rows[0];

  const owns = row
    ? session?.user.id
      ? row.userId === session.user.id
      : row.userId === null &&
        claimToken !== null &&
        row.claimToken === claimToken
    : false;
  if (!owns) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // No entry → never started here, evicted after the grace window, or the
  // process restarted. The client falls back to the DB-rendered conversation.
  const body = subscribe(conversationId, offset);
  if (!body) {
    return Response.json({ error: "no active stream" }, { status: 404 });
  }

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Conversation-Id": conversationId,
    },
  });
}
