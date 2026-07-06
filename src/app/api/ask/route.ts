/**
 * POST /api/ask — Task 5.7
 *
 * Thin route handler that wires real deps into handleAsk (the testable
 * orchestrator in src/lib/chat/ask-handler.ts) and maps the result to a
 * Next.js Response.
 *
 * Streaming pattern: the Anthropic SDK's MessageStream exposes `.toReadableStream()`
 * which returns a standard Web API ReadableStream of the raw streaming events
 * (newline-delimited JSON). We run it through toTextStream (sse-text-stream.ts)
 * to forward ONLY the visible answer text — dropping the model's private
 * thinking and the JSON envelope — then hand it to the stream registry
 * (stream-registry.ts), whose detached consumer reads it to completion
 * regardless of the client connection. The response body is a registry
 * subscriber; GET /api/ask/stream re-attaches from an offset after a client
 * disconnect (resumable-chat-streams design spec).
 *
 * Cookie signing: the claimToken cookie (fiska_claim) is HMAC-SHA256 signed with
 * BETTER_AUTH_SECRET before it is set, and its signature is verified on read (see
 * src/lib/chat/claim-cookie.ts, ADR-0001).  The cookie stays HttpOnly + Secure +
 * SameSite=Lax; the signature lets the server reject a tampered/forged token
 * without a DB round-trip.  A missing or invalid signature reads as "no claim".
 */

import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { after } from "next/server";
import { emit } from "@/lib/analytics/events";
import { extractClientIp, hashSignupIp } from "@/lib/auth/signup-ip";
import {
  adviseFirst,
  adviseFollowup,
  getLakeLockRedirect,
  isLakeLockViolation,
} from "@/lib/chat/advise";
import type {
  AskHandlerDeps,
  AskResult,
  ConversationStatus,
} from "@/lib/chat/ask-handler";
import {
  ANON_IP_WINDOW_MS,
  handleAsk,
  PAID_COST_WINDOW_MS,
  PAID_FAIR_USE_WINDOW_MS,
} from "@/lib/chat/ask-handler";
import { signClaimToken, verifyClaimToken } from "@/lib/chat/claim-cookie";
import { extract } from "@/lib/chat/extractor";
import {
  type PersistTurnsDeps,
  persistAssistantTurn,
  persistClarifyTurns,
  persistUserTurn,
} from "@/lib/chat/persist-turns";
import {
  canSpendCredit,
  chatTurnAllowed,
  freezeConversation,
  refundCredit,
  spendCredit,
} from "@/lib/chat/quota";
import { toTextStream } from "@/lib/chat/sse-text-stream";
import {
  isActive,
  StreamConflictError,
  startStream,
  subscribe,
} from "@/lib/chat/stream-registry";
import { ExternalServiceError, TimeoutError } from "@/lib/errors";
import { getSession } from "@/lib/get-session";
import { isAdminEmail } from "@/lib/is-admin";
import { candidateLakes } from "@/lib/lakes/candidates";
import { resolveLakeWithHaiku } from "@/lib/lakes/haiku-resolver";
import { notifyDiscord } from "@/lib/notify/discord";
import { buildSignals } from "@/lib/signals/build";
import { buildAreaSignals } from "@/lib/signals/build-area";
import { db } from "@/shared/db/client";
import {
  analyticsEvents,
  conversations,
  messages,
  users,
} from "@/shared/db/schema";
import { env } from "@/shared/env";

const CLAIM_TOKEN_COOKIE = "fiska_claim";

/** L1: max accepted user message length (bytes ≈ chars for typical input). */
const MAX_MESSAGE_LENGTH = 4096;

/**
 * M7: hard ceiling on the raw request body, checked via Content-Length BEFORE
 * reading/parsing. The only legitimate body is `{ message, conversationId? }`;
 * the message itself is capped at MAX_MESSAGE_LENGTH, so 8 KB is generous for
 * JSON overhead. Rejecting on Content-Length stops a multi-MB body from being
 * buffered + parsed (a cheap DoS amplifier) before the post-parse length check.
 */
const MAX_BODY_BYTES = 8 * 1024;

/** L1: UUID v4-ish shape for conversationId boundary validation. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * M13: same-origin / CSRF guard for this cookie-authed, state-changing POST.
 * /api/ask creates conversations, spends credits and freezes chats authed by
 * the Better Auth session cookie, so a cross-site form/fetch could drive it.
 *
 * Strategy (defense-in-depth, alongside SameSite=Lax on the session cookie):
 *  - If Sec-Fetch-Site is present (all modern browsers send it), require it to
 *    be "same-origin" or "same-site"; reject "cross-site".
 *  - Else fall back to comparing the Origin header against the app origin.
 *  - If neither header is present (non-browser caller / server-to-server),
 *    allow — there is no browser ambient authority to abuse.
 *
 * Returns true when the request is allowed.
 */
export function isSameOriginRequest(
  headers: Headers,
  appOrigin: string,
): boolean {
  const secFetchSite = headers.get("sec-fetch-site");
  if (secFetchSite) {
    return secFetchSite === "same-origin" || secFetchSite === "same-site";
  }
  const origin = headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === new URL(appOrigin).origin;
    } catch {
      return false;
    }
  }
  // No Origin and no Sec-Fetch-Site → not a browser-initiated cross-site POST.
  return true;
}

/**
 * H2: serialize the claim cookie as an explicit Set-Cookie header value.
 * Mirrors the prior cookieStore.set options: HttpOnly, SameSite=Lax, Path=/,
 * and Secure only in production (L3 — so the gate cookie works over
 * http://localhost in dev). The value is a UUID v4 (no escaping needed).
 */
export function serializeClaimCookie(name: string, value: string): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/**
 * Sweden-ish bounding box for the optional browser geolocation. Exported for
 * tests. Anything outside is dropped (VPN exits, spoofed coords, GPS noise).
 */
export function parseLocation(
  value: unknown,
): { lat: number; lon: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { lat, lon } = value as { lat?: unknown; lon?: unknown };
  if (typeof lat !== "number" || typeof lon !== "number") return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (lat < 54 || lat > 70 || lon < 9 || lon > 26) return undefined;
  return { lat, lon };
}

/** H1: in-persona Swedish fallback the chat UI renders as a generic error. */
const GENERIC_ERROR_MESSAGE =
  "Något krånglar i tacklingen just nu, hörru. Kasta igen om en stund.";

/**
 * Resumable streams: one live advice stream per conversation. A duplicate
 * submit while the previous answer is still generating would double-bill and
 * interleave persistence — reject it and let the client keep (or re-attach
 * to) the stream that is already running.
 */
function busyResponse(): Response {
  return Response.json(
    {
      type: "busy",
      text: "Gubben håller redan på att svara i den här chatten. Vänta tills han pratat klart.",
    },
    { status: 409 },
  );
}

/**
 * H1: classify an unexpected error from handleAsk into a stable in-persona
 * gate JSON the chat UI already handles, instead of leaking a raw 500.
 *
 * Without @mysterylane/errors available (not in the registry — see findings
 * H1), we classify on the error shape we can observe: an Anthropic 429 →
 * rate-limited (503), everything else → generic upstream/internal error (500).
 * The body shape `{ type, text }` matches the gate contract chat.tsx renders.
 */
export function classifyError(err: unknown): Response {
  // M12: classify a rate-limit on the TYPED error. The extractor/forecast wrap
  // upstream failures as ExternalServiceError and now thread the upstream
  // `status` through the constructor, so `err.status === 429` is reachable
  // (previously the raw status was lost in the re-wrap → this branch was dead
  // → every 429 fell through to a generic 503/500).
  const status =
    err instanceof ExternalServiceError
      ? err.status
      : (err as { status?: number } | null)?.status;
  if (status === 429) {
    return Response.json(
      {
        type: "lake_unresolved",
        text: "Det är fullt på sjön just nu. Vänta en stund och kasta igen.",
      },
      { status: 503 },
    );
  }
  // M14: a typed upstream failure (Anthropic/SMHI outage or timeout) maps to
  // 503 — a transient "try again" — rather than a generic 500 (and crucially,
  // an extractor outage is NOT silently rendered as an off-topic refusal).
  if (err instanceof ExternalServiceError || err instanceof TimeoutError) {
    return Response.json(
      { type: "lake_unresolved", text: GENERIC_ERROR_MESSAGE },
      { status: 503 },
    );
  }
  return Response.json(
    { type: "lake_unresolved", text: GENERIC_ERROR_MESSAGE },
    { status: 500 },
  );
}

function buildDeps(): AskHandlerDeps {
  return {
    // ── Identity ──────────────────────────────────────────────────────────
    // H2: surface an IdP-supplied gender to the handler when present.  Better
    // Auth's user row currently has no gender column, so this is undefined in
    // practice → neutral tilltal (the common case per CONTEXT.md).  The param
    // is threaded end-to-end here so the gendered-tilltal path is reachable the
    // moment a gender field is added to the session/account.
    // [~] deferred: IdP gender field not yet on the Better Auth session.
    // isAdmin (ADMIN_EMAILS allowlist) lifts the credit cap + chat-turn limit.
    getSession: async () => {
      const session = await getSession();
      if (!session) return null;
      const gender = (session.user as { gender?: string | null }).gender;
      return {
        user: {
          id: session.user.id,
          gender,
          isAdmin: isAdminEmail(session.user.email),
        },
      };
    },

    // ── DB reads ──────────────────────────────────────────────────────────
    getConversation: async (id) => {
      const rows = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);
      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        id: row.id,
        userId: row.userId,
        claimToken: row.claimToken,
        frozen: row.frozen,
        status: row.status as ConversationStatus,
        resolveAttempts: row.resolveAttempts,
        userLat: row.userLat,
        userLon: row.userLon,
        signalsSnapshot: row.signalsSnapshot ?? null,
        lakeId: row.lakeId,
        // I1 + M1 + M9: use ONLY the bare lake name ("Tolken") as the lake-lock
        // key, dug out of the frozen signalsSnapshot jsonb (not a row column).
        // Never fall back to the formatted label ("Tolken (Borås, …)"): a bare
        // user lake name can never equal the label, so a label fallback yields
        // a false lock that blocks legitimate follow-ups (M1).  Legacy rows
        // without bareLakeName → null → the handler skips the lock entirely
        // (degrades to no-lock rather than a false block).
        bareLakeName: row.signalsSnapshot?.bareLakeName ?? null,
      };
    },

    countUserMessages: async (conversationId) => {
      const rows = await db
        .select({ n: count() })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.role, "user"),
          ),
        );
      return rows[0]?.n ?? 0;
    },

    getHistoryMessages: async (conversationId) => {
      // H3: order by createdAt so history reaches the extractor / adviseFollowup
      // in sequence.  Without ORDER BY, Postgres returns rows in arbitrary
      // order → shuffled history → degraded advice.  createdAt is the stable
      // ordering minimum the schema supports (no separate sequence column;
      // timestamps are sub-second so true ties are unlikely on inserts).
      const rows = await db
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt));
      return rows.map((r) => ({
        role: r.role as "user" | "assistant",
        content: r.content,
      }));
    },

    getUserRow: async (userId) => {
      const rows = await db
        .select({ isPaid: users.isPaid, creditsUsed: users.creditsUsed })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0] ?? null;
    },

    // ── Leaf modules ──────────────────────────────────────────────────────
    extract: (message, history) => extract(message, history),
    candidateLakes: (name, userLoc) => candidateLakes(name, userLoc),
    resolveLakeWithHaiku: (params) => resolveLakeWithHaiku(params),
    buildSignals: ({ lake, targetTime, now }) =>
      buildSignals({
        lake: { ...lake, name: lake.name ?? lake.id },
        targetTime,
        now,
      }),
    buildAreaSignals: (input) => buildAreaSignals(input),
    adviseFirst: ({ signals, message, history, gender }) =>
      adviseFirst({ signals, message, history: history ?? [], gender }),
    adviseFollowup: ({ snapshot, message, history, turnIndex, gender }) =>
      adviseFollowup({
        snapshot,
        message,
        history: history ?? [],
        turnIndex,
        gender,
      }),
    isLakeLockViolation,
    getLakeLockRedirect,
    canSpendCredit,
    spendCredit: (userId) => spendCredit(userId),
    chatTurnAllowed,
    freezeConversation: (id) => freezeConversation(id),

    // ── DB writes (resolution lifecycle) ──────────────────────────────────
    createPendingConversation: async ({
      userId,
      claimToken,
      userLat,
      userLon,
      title,
      anonIpHash,
    }) => {
      const id = randomUUID();
      await db.insert(conversations).values({
        id,
        userId: userId ?? null,
        claimToken: claimToken ?? null,
        status: "lake_pending",
        userLat: userLat ?? null,
        userLon: userLon ?? null,
        title: title ?? null,
        anonIpHash: anonIpHash ?? null,
      });
      return id;
    },
    countRecentAnonConversationsByIp: async (ipHash) => {
      const since = new Date(Date.now() - ANON_IP_WINDOW_MS);
      const rows = await db
        .select({ n: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.anonIpHash, ipHash),
            gt(conversations.createdAt, since),
          ),
        );
      return rows[0]?.n ?? 0;
    },
    countRecentConversationsByUser: async (userId) => {
      const since = new Date(Date.now() - PAID_FAIR_USE_WINDOW_MS);
      const rows = await db
        .select({ n: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.userId, userId),
            gt(conversations.createdAt, since),
          ),
        );
      return rows[0]?.n ?? 0;
    },
    getRecentLlmCostUsdByUser: async (userId) => {
      // Sum of llm_usage costUsd attributed via conversations — the annual
      // cost-budget gate input. Unpriced rows (costUsd null) sum as 0 here;
      // the dashboard's "Unpriced calls" tile alerts on those separately.
      const since = new Date(Date.now() - PAID_COST_WINDOW_MS);
      const rows = await db.execute<{ cost: number | null }>(sql`
        SELECT sum((e.payload->>'costUsd')::float) AS cost
        FROM ${analyticsEvents} e
        JOIN ${conversations} c ON c.id = e.conversation_id
        WHERE e.type = 'llm_usage'
          AND c.user_id = ${userId}
          AND e.created_at >= ${since.toISOString()}
      `);
      return rows[0]?.cost ?? 0;
    },
    transitionConversation: async ({
      id,
      status,
      lakeId,
      targetTime,
      signalsSnapshot,
    }) => {
      await db
        .update(conversations)
        .set({ status, lakeId, targetTime, signalsSnapshot })
        .where(eq(conversations.id, id));
    },
    incrementResolveAttempts: async (id) => {
      await db
        .update(conversations)
        .set({ resolveAttempts: sql`${conversations.resolveAttempts} + 1` })
        .where(eq(conversations.id, id));
    },

    // ── Analytics ─────────────────────────────────────────────────────────
    emit: (event) => emit(event),

    // ── Clock ─────────────────────────────────────────────────────────────
    now: new Date(),
  };
}

/**
 * M8: the post-stream turn writers live with the route (their only caller),
 * not on AskHandlerDeps — handleAsk never persists turns. persistTurns
 * (src/lib/chat/persist-turns.ts) closes over these.
 */
function buildPersistDeps(): PersistTurnsDeps {
  return {
    persistMessage: async ({ conversationId, role, content }) => {
      await db.insert(messages).values({
        id: randomUUID(),
        conversationId,
        role,
        content,
      });
    },
    updateLastActive: async (conversationId) => {
      await db
        .update(conversations)
        .set({ lastActiveAt: new Date() })
        .where(eq(conversations.id, conversationId));
    },
    emit: (event) => emit(event),
    refundCredit: (userId) => refundCredit(userId),
  };
}

export async function POST(request: Request): Promise<Response> {
  // M13: reject cross-site requests before doing any work. /api/ask is a
  // cookie-authed, state-changing endpoint; an Origin/Sec-Fetch-Site check
  // closes the CSRF gap that Content-Type: application/json alone does not.
  if (!isSameOriginRequest(request.headers, env.BETTER_AUTH_URL)) {
    return Response.json(
      { error: "cross-site request rejected" },
      {
        status: 403,
      },
    );
  }

  // M7: reject an oversized body via Content-Length BEFORE buffering/parsing it,
  // so a multi-MB payload can't be fully read just to be rejected by the
  // post-parse length check. The post-parse MAX_MESSAGE_LENGTH check below
  // stays as defense-in-depth (Content-Length can be absent or spoofed).
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: "request body too large" }, { status: 413 });
  }

  // Parse request body
  let body: {
    message?: unknown;
    conversationId?: unknown;
    location?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : null;
  if (!message) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }
  // L1: cap message length (cost amplification — every char is billed to the
  // extractor + advisor). ~4 KB is generous for a fishing question.
  if (message.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ error: "message too long" }, { status: 413 });
  }

  // L1: validate conversationId is a UUID at the boundary before any Claude
  // call (it is surfaced to clients via X-Conversation-Id, so it is attacker-
  // controlled). A malformed id can never own a conversation anyway.
  const rawConversationId =
    typeof body.conversationId === "string" ? body.conversationId : undefined;
  if (rawConversationId !== undefined && !UUID_RE.test(rawConversationId)) {
    return Response.json({ error: "invalid conversationId" }, { status: 400 });
  }
  const conversationId = rawConversationId;

  // Resumable streams: reject a double submit for a conversation whose advice
  // stream is still generating, BEFORE spending any extractor/advisor tokens.
  // (startStream below re-checks under the same lock for the raced case.)
  if (conversationId && isActive(conversationId)) {
    return busyResponse();
  }

  // Optional browser geolocation. Silently ignore anything malformed or
  // outside a generous Sweden-ish bounding box (bogus coords must not steer
  // resolution or SMHI fetches) — location is a hint, never a hard input.
  const location = parseLocation(body.location);

  // Pre-read the claim token cookie (cookies() is async in Next.js 16) and
  // verify its HMAC signature.  A missing, malformed, or tampered signature
  // yields null → treated exactly like "no claim cookie" (see claim-cookie.ts).
  const cookieStore = await cookies();
  const claimToken = verifyClaimToken(
    cookieStore.get(CLAIM_TOKEN_COOKIE)?.value,
  );

  // Anon abuse guard input: hash the client IP (no raw IPs at rest). The
  // handler only applies it to anon NEW conversations.
  const clientIp = extractClientIp(request.headers);
  const anonIpHash = clientIp ? hashSignupIp(clientIp) : null;

  // H6: pass the pre-read claimToken into handleAsk on the input rather than
  // mutating a built deps object (the old `deps.getClaimToken = …` hack).
  const deps = buildDeps();

  // H1: wrap the orchestrator in a try/catch error boundary.  Any Haiku/DB/
  // buildSignals rejection would otherwise become a raw Next 500 (stack leak
  // in dev, no in-persona body the chat UI can render).  Classify and return a
  // stable in-persona Swedish gate the existing chat UI already handles.
  let result: AskResult;
  try {
    result = await handleAsk(
      { message, conversationId, claimToken, location, anonIpHash },
      deps,
    );
  } catch (err) {
    // L-rt1: emit a queryable pipeline_error so a failure escaping handleAsk is
    // visible in analytics (previously the catch returned a classified Response
    // with zero observability). Best-effort — never block the error response.
    await emit({
      type: "pipeline_error",
      ...(conversationId ? { conversationId } : {}),
      payload: { reason: err instanceof Error ? err.message : String(err) },
    }).catch(() => {});
    // Ops ping (this catch means onRequestError never sees the error).
    void notifyDiscord(
      "alerts",
      `🚨 **/api/ask pipeline_error**\n\`\`\`${
        err instanceof Error ? err.message : String(err)
      }\`\`\``,
    );
    return classifyError(err);
  }

  // ── Map result to Response ──────────────────────────────────────────────

  if (result.type === "stream") {
    // Stream Anthropic text deltas to the client.
    // toReadableStream() emits the SDK's raw SSE JSON frames (message_start,
    // content_block_delta, thinking_delta, …). toTextStream parses those
    // server-side and forwards ONLY the visible text_delta text — so the client
    // gets clean text/plain and the model's private `thinking` never leaves the
    // server (first-turn advice runs with adaptive thinking).
    const readable = toTextStream(result.stream.toReadableStream());
    const { conversationId: streamConvId, stream } = result;

    // Resumable streams: hand the text stream to the registry's DETACHED
    // consumer instead of using it as the response body. Generation now runs
    // to completion regardless of the client connection; the response below is
    // just a subscriber, and GET /api/ask/stream can re-attach from any
    // offset. A conflict here means a same-conversation double submit raced
    // past the isActive guard above.
    try {
      startStream(streamConvId, readable);
    } catch (err) {
      if (err instanceof StreamConflictError) return busyResponse();
      throw err;
    }

    // Persist the user turn BEFORE handing out the stream, so the question
    // survives a failed or abandoned assistant stream (never throws).
    const persistDeps = buildPersistDeps();
    await persistUserTurn(persistDeps, {
      conversationId: streamConvId,
      message,
    });

    // H4: persist the assistant turn with Next 16's after(). It awaits
    // finalMessage(), which — thanks to the registry consumer — now settles
    // even when every client is gone, persists the assistant text, always
    // rolls lastActiveAt forward and emits `persistence_failure` instead of
    // throwing (H3a / M11).
    after(() =>
      persistAssistantTurn(persistDeps, {
        conversationId: streamConvId,
        stream,
        // Refund the credit if the first-turn Sonnet stream fails (ADR-0004).
        // Present only when a credit was actually spent for this turn.
        ...(result.refundUserId !== undefined
          ? { refundUserId: result.refundUserId }
          : {}),
      }),
    );

    // Build the response headers up front so we can attach Set-Cookie directly.
    const headers = new Headers({
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "X-Conversation-Id": result.conversationId,
    });

    // Badge payload for the chat UI (lake/area label + key conditions). Known
    // before the stream starts — signals are built before adviseFirst. Header
    // values must be ASCII → URI-encode the JSON.
    if (result.badges) {
      headers.set(
        "X-Signals",
        encodeURIComponent(JSON.stringify(result.badges)),
      );
    }

    // Set claim token cookie for new anon conversations.
    // handleAsk returns claimToken on the stream result when it created a new
    // anon conversation. Without this cookie the anon quota gate (isAnon &&
    // claimToken !== null) can never trip, giving anon users unlimited prompts.
    //
    // H2: in Next 16 a cookies().set() mutation is NOT guaranteed to be applied
    // to a hand-built `new Response(readable, …)` (only to a framework-owned or
    // NextResponse response). If it were dropped, the anon gate would never trip
    // → unlimited anonymous Sonnet first-prompts. So we write the Set-Cookie
    // header EXPLICITLY onto this Response's headers (verified by route.test.ts)
    // rather than relying on the mutation propagating.
    //
    // #5: the raw token is HMAC-signed (signClaimToken) before it goes on the
    // wire so the read side can reject a tampered value without a DB read
    // (ADR-0001). serializeClaimCookie applies the HttpOnly/SameSite/Secure/Path
    // flags on the explicit header.
    if (result.claimToken) {
      headers.append(
        "Set-Cookie",
        serializeClaimCookie(
          CLAIM_TOKEN_COOKIE,
          signClaimToken(result.claimToken),
        ),
      );
    }

    // The response body is a registry SUBSCRIBER from offset 0 — cancelling it
    // (client disconnect) only unsubscribes; the consumer keeps generating.
    const body = subscribe(streamConvId, 0);
    if (!body) {
      // Unreachable in practice (the entry was registered synchronously
      // above); classify rather than crash if the registry ever surprises us.
      return classifyError(new Error("advice stream unavailable"));
    }
    return new Response(body, { headers });
  }

  // Clarify round (rebuild spec): a free Haiku follow-up question. Persist
  // BOTH turns post-response (the next resolver round needs them as history)
  // and expose the conversation id + claim cookie exactly like the stream
  // path, so the client can continue the same conversation.
  if (result.type === "clarify") {
    const clarify = result;
    after(() =>
      persistClarifyTurns(buildPersistDeps(), {
        conversationId: clarify.conversationId,
        message,
        clarifyText: clarify.text,
      }),
    );

    const headers = new Headers({
      "Content-Type": "application/json",
      "X-Conversation-Id": clarify.conversationId,
    });
    if (clarify.claimToken) {
      headers.append(
        "Set-Cookie",
        serializeClaimCookie(
          CLAIM_TOKEN_COOKIE,
          signClaimToken(clarify.claimToken),
        ),
      );
    }
    return new Response(
      JSON.stringify({ type: "clarify", text: clarify.text }),
      { headers },
    );
  }

  // Non-stream gate responses — structured JSON
  const { type, text } = result;
  const status =
    type === "out_of_credits" ? 402 : type === "rate_limited" ? 429 : 200;
  return Response.json({ type, text }, { status });
}
