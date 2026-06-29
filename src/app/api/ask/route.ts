/**
 * POST /api/ask — Task 5.7
 *
 * Thin route handler that wires real deps into handleAsk (the testable
 * orchestrator in src/lib/chat/ask-handler.ts) and maps the result to a
 * Next.js Response.
 *
 * Streaming pattern: the Anthropic SDK's MessageStream exposes `.toReadableStream()`
 * which returns a standard Web API ReadableStream.  We pass that directly to
 * `new Response(stream)` — the pattern documented in Next.js route.md.
 *
 * Cookie signing: the claimToken is stored in a plain HttpOnly, SameSite=Lax,
 * Secure cookie.  Full cryptographic signing (HMAC/JWE) is deferred — see TODO
 * below.  The token itself is a UUID v4 (128-bit entropy), which is unguessable
 * in practice, but a signed cookie would prevent server-side DB reads on every
 * request to verify the token hasn't been tampered with.
 *
 * TODO (DONE_WITH_CONCERNS: cookie signing):
 *   The claimToken cookie is currently stored unsigned.  It is HttpOnly + Secure
 *   so it cannot be read by client JS and is sent only over HTTPS, but it is not
 *   cryptographically signed.  Add HMAC signing (e.g. `iron-session` or a custom
 *   HMAC-SHA256 with a server secret) before production.  The UUID entropy makes
 *   guessing infeasible; the main risk is log/debug exposure of the raw token.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { after } from "next/server";
import { emit } from "@/lib/analytics/events";
import {
  adviseFirst,
  adviseFollowup,
  getLakeLockRedirect,
  isLakeLockViolation,
} from "@/lib/chat/advise";
import type { AskHandlerDeps, AskResult } from "@/lib/chat/ask-handler";
import { handleAsk } from "@/lib/chat/ask-handler";
import { extract } from "@/lib/chat/extractor";
import {
  canSpendCredit,
  chatTurnAllowed,
  freezeConversation,
  spendCredit,
} from "@/lib/chat/quota";
import { getSession } from "@/lib/get-session";
import { resolveLake } from "@/lib/lakes/resolve";
import { buildSignals } from "@/lib/signals/build";
import { db } from "@/shared/db/client";
import { conversations, messages, users } from "@/shared/db/schema";

const CLAIM_TOKEN_COOKIE = "fiska_claim";

/** L1: max accepted user message length (bytes ≈ chars for typical input). */
const MAX_MESSAGE_LENGTH = 4096;

/** L1: UUID v4-ish shape for conversationId boundary validation. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** H1: in-persona Swedish fallback the chat UI renders as a generic error. */
const GENERIC_ERROR_MESSAGE =
  "något krånglar i tacklingen just nu, grabben — kasta igen om en stund.";

/**
 * H1: classify an unexpected error from handleAsk into a stable in-persona
 * gate JSON the chat UI already handles, instead of leaking a raw 500.
 *
 * Without @mysterylane/errors available (not in the registry — see findings
 * H1), we classify on the error shape we can observe: an Anthropic 429 →
 * rate-limited (503), everything else → generic upstream/internal error (500).
 * The body shape `{ type, text }` matches the gate contract chat.tsx renders.
 */
function classifyError(err: unknown): Response {
  const status = (err as { status?: number } | null)?.status;
  if (status === 429) {
    return Response.json(
      {
        type: "lake_unresolved",
        text: "det är fullt på sjön just nu — vänta en stund och kasta igen.",
      },
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
    getSession: async () => {
      const session = await getSession();
      if (!session) return null;
      const gender = (session.user as { gender?: string | null }).gender;
      return { user: { id: session.user.id, gender } };
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
        signalsSnapshot: row.signalsSnapshot ?? null,
        lakeId: row.lakeId,
        // I1 + M1: use ONLY the bare lake name ("Tolken") as the lake-lock key.
        // Never fall back to the formatted label ("Tolken (Borås, …)"): a bare
        // user lake name can never equal the label, so a label fallback yields
        // a false lock that blocks legitimate follow-ups (M1).  Legacy rows
        // without bareLakeName → null → the handler skips the lock entirely
        // (degrades to no-lock rather than a false block).
        lakeName: row.signalsSnapshot?.bareLakeName ?? null,
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
    resolveLake: (name, municipality) => resolveLake(name, municipality),
    buildSignals: ({ lake, targetTime, now }) =>
      buildSignals({
        lake: { ...lake, name: lake.name ?? lake.id },
        targetTime,
        now,
      }),
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

    // ── DB writes ─────────────────────────────────────────────────────────
    createConversation: async ({
      userId,
      claimToken,
      lakeId,
      targetTime,
      signalsSnapshot,
    }) => {
      const id = randomUUID();
      await db.insert(conversations).values({
        id,
        userId: userId ?? null,
        claimToken: claimToken ?? null,
        lakeId,
        targetTime: targetTime ?? null,
        signalsSnapshot,
      });
      return id;
    },

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

    // ── Analytics ─────────────────────────────────────────────────────────
    emit: (event) => emit(event),

    // ── Clock ─────────────────────────────────────────────────────────────
    now: new Date(),
  };
}

export async function POST(request: Request): Promise<Response> {
  // Parse request body
  let body: { message?: unknown; conversationId?: unknown };
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

  // Pre-read the claim token cookie (cookies() is async in Next.js 16)
  const cookieStore = await cookies();
  const claimToken = cookieStore.get(CLAIM_TOKEN_COOKIE)?.value ?? null;

  // H6: pass the pre-read claimToken into handleAsk on the input rather than
  // mutating a built deps object (the old `deps.getClaimToken = …` hack).
  const deps = buildDeps();

  // H1: wrap the orchestrator in a try/catch error boundary.  Any Haiku/DB/
  // buildSignals rejection would otherwise become a raw Next 500 (stack leak
  // in dev, no in-persona body the chat UI can render).  Classify and return a
  // stable in-persona Swedish gate the existing chat UI already handles.
  let result: AskResult;
  try {
    result = await handleAsk({ message, conversationId, claimToken }, deps);
  } catch (err) {
    return classifyError(err);
  }

  // ── Map result to Response ──────────────────────────────────────────────

  if (result.type === "stream") {
    // Stream Anthropic text deltas to the client
    // Using Anthropic SDK's .toReadableStream() → standard Web ReadableStream
    const readable = result.stream.toReadableStream();
    const { conversationId: streamConvId, stream } = result;

    // H4: persist turns with Next 16's after() so the work survives the
    // response close on serverless (uses waitUntil under the hood) instead of
    // a detached IIFE that can be reclaimed.  See
    // node_modules/next/dist/docs/.../after.md — valid in Route Handlers, runs
    // after the response is finished.  A persistence failure now emits a
    // `persistence_failure` analytics event instead of being silently
    // swallowed by `catch {}` (zero observability before).
    after(async () => {
      try {
        await deps.persistMessage({
          conversationId: streamConvId,
          role: "user",
          content: message,
        });
        const final = await stream.finalMessage();
        const assistantText = final.content
          .filter((c) => c.type === "text")
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        if (assistantText) {
          await deps.persistMessage({
            conversationId: streamConvId,
            role: "assistant",
            content: assistantText,
          });
        }
        await deps.updateLastActive(streamConvId);
      } catch (err) {
        await deps.emit({
          type: "persistence_failure",
          conversationId: streamConvId,
          payload: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    });

    // Set claim token cookie for new anon conversations.
    // handleAsk returns claimToken on the stream result when it created a new
    // anon conversation. Without this cookie the anon quota gate (isAnon &&
    // claimToken !== null) can never trip, giving anon users unlimited prompts.
    if (result.claimToken) {
      cookieStore.set(CLAIM_TOKEN_COOKIE, result.claimToken, {
        httpOnly: true,
        sameSite: "lax",
        // L3: only require Secure in production so the anon-gate cookie works
        // over http://localhost during local development.
        secure: process.env.NODE_ENV === "production",
        path: "/",
      });
    }

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "X-Conversation-Id": result.conversationId,
      },
    });
  }

  // Non-stream gate responses — structured JSON
  const { type, text } = result;
  return Response.json(
    { type, text },
    {
      status: type === "out_of_credits" ? 402 : 200,
    },
  );
}
