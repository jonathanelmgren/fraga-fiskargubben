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
import { and, count, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { emit } from "@/lib/analytics/events";
import {
  adviseFirst,
  adviseFollowup,
  getLakeLockRedirect,
  isLakeLockViolation,
} from "@/lib/chat/advise";
import type { AskHandlerDeps } from "@/lib/chat/ask-handler";
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

function buildDeps(): AskHandlerDeps {
  return {
    // ── Identity ──────────────────────────────────────────────────────────
    getSession: () => getSession(),
    getClaimToken: () => {
      // TODO (DONE_WITH_CONCERNS: cookie signing): read signed cookie;
      // currently reads unsigned HttpOnly cookie value directly.
      // This is evaluated synchronously — cookies() is called during
      // the route handler execution context.
      // Note: cookies() returns a promise in Next.js 16; we use a lazy
      // async wrapper to defer this to call-time.
      // We cannot await here since getClaimToken is sync in the deps type.
      // The route pre-reads the cookie before calling handleAsk — see POST().
      return null; // overridden per-request in POST()
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
        lakeName: row.signalsSnapshot?.lake ?? null,
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
      const rows = await db
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, conversationId));
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
    adviseFirst: ({ signals, message, history }) =>
      adviseFirst({ signals, message, history: history ?? [] }),
    adviseFollowup: ({ snapshot, message, history, turnIndex }) =>
      adviseFollowup({ snapshot, message, history: history ?? [], turnIndex }),
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

  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId : undefined;

  // Pre-read the claim token cookie (cookies() is async in Next.js 16)
  const cookieStore = await cookies();
  const claimToken = cookieStore.get(CLAIM_TOKEN_COOKIE)?.value ?? null;

  // Build deps, override getClaimToken with the pre-read value
  const deps = buildDeps();
  deps.getClaimToken = () => claimToken;

  // Run the orchestrator
  const result = await handleAsk({ message, conversationId }, deps);

  // ── Map result to Response ──────────────────────────────────────────────

  if (result.type === "stream") {
    // Stream Anthropic text deltas to the client
    // Using Anthropic SDK's .toReadableStream() → standard Web ReadableStream
    const readable = result.stream.toReadableStream();

    // Persist messages after streaming completes (fire-and-forget)
    // We persist the user message immediately; assistant message after finalMessage
    void (async () => {
      try {
        await deps.persistMessage({
          conversationId: result.conversationId,
          role: "user",
          content: message,
        });
        const final = await result.stream.finalMessage();
        const assistantText = final.content
          .filter((c) => c.type === "text")
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        if (assistantText) {
          await deps.persistMessage({
            conversationId: result.conversationId,
            role: "assistant",
            content: assistantText,
          });
        }
        await deps.updateLastActive(result.conversationId);
      } catch {
        // Persistence failures are non-fatal (analytics already captured)
      }
    })();

    // Set claim token cookie for new anon conversations.
    // handleAsk returns claimToken on the stream result when it created a new
    // anon conversation. Without this cookie the anon quota gate (isAnon &&
    // claimToken !== null) can never trip, giving anon users unlimited prompts.
    if (result.claimToken) {
      cookieStore.set(CLAIM_TOKEN_COOKIE, result.claimToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: true,
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
