/**
 * ask-handler.ts — Task 5.7
 *
 * The orchestration logic for POST /api/ask, extracted into a pure function
 * with injected dependencies so it can be unit-tested without a real server,
 * DB, or Claude API.
 *
 * Gate ordering (ADR-0001 / ADR-0003 / ADR-0004):
 *  1. Identity: session OR anon claim token
 *  2. Anon quota gate (≤1 prompt per anon identity)
 *  3. Chat-turn limit / frozen check (if following up)
 *  4. Extractor (Haiku) → topic gate
 *  5a. New convo: resolveLake → credit gate → buildSignals → spendCredit → adviseFirst (Sonnet)
 *  5b. Follow-up: lake-lock check → adviseFollowup (Haiku) with frozen snapshot
 *
 * The route.ts file calls handleAsk, wires real deps, and maps the result to
 * a Next.js Response (stream or JSON).
 */

import { randomUUID } from "node:crypto";
import type { AnalyticsEvent } from "@/lib/analytics/events";
import type { Extraction, HistoryMessage } from "@/lib/chat/extractor";
import type { Lake } from "@/lib/lakes/resolve";
import { formatLabel } from "@/lib/lakes/resolve-helpers";
import type { Signals } from "@/lib/signals/types";
import {
  ANON_REGISTER_MESSAGE,
  CHAT_LIMIT_MESSAGE,
  LAKE_UNRESOLVED_MESSAGE,
  OUT_OF_CREDITS_MESSAGE,
} from "./gate-messages";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AskInput = {
  message: string;
  conversationId?: string;
  /**
   * The anon claim token pre-read from the request cookie (H6: passed in
   * explicitly instead of mutating a built deps object). Null for logged-in
   * callers or anon callers without a token yet.
   */
  claimToken?: string | null;
};

/** Shape of a conversation row from the DB (only fields we need). */
export type ConversationRow = {
  id: string;
  userId: string | null;
  claimToken?: string | null;
  frozen: boolean;
  signalsSnapshot?: Signals | null;
  lakeId?: string | null;
  /** lakeName is the resolved name stored on the row (for lake-lock checks). */
  lakeName?: string | null;
};

/** Minimal user row for quota checks. */
export type UserRow = {
  isPaid: boolean;
  creditsUsed: number;
};

/** Minimal stream interface returned by advise functions. */
export type AdviceStream = {
  toReadableStream(): ReadableStream;
  finalMessage(): Promise<{ content: Array<{ type: string; text?: string }> }>;
};

// ---------------------------------------------------------------------------
// AskHandlerDeps — all injectable dependencies
// ---------------------------------------------------------------------------

export type AskHandlerDeps = {
  // Identity
  getSession(): Promise<{
    user: { id: string; gender?: string | null };
  } | null>;

  // DB reads
  getConversation(id: string): Promise<ConversationRow | null>;
  countUserMessages(conversationId: string): Promise<number>;
  getHistoryMessages(conversationId: string): Promise<HistoryMessage[]>;
  getUserRow(userId: string): Promise<UserRow | null>;

  // Leaf modules (thin wrappers over the real fns)
  extract(message: string, history: HistoryMessage[]): Promise<Extraction>;
  resolveLake(name: string, municipality?: string): Promise<Lake | null>;
  buildSignals(input: {
    lake: Lake & { label: string };
    targetTime: Date;
    now: Date;
  }): Promise<Signals>;
  adviseFirst(params: {
    signals: Signals;
    message: string;
    history: HistoryMessage[];
    /** H2: IdP-supplied gender for gendered tilltal; undefined → neutral. */
    gender?: string;
  }): AdviceStream;
  adviseFollowup(params: {
    snapshot: Signals;
    message: string;
    history: HistoryMessage[];
    turnIndex: number;
    /** H2: IdP-supplied gender for gendered tilltal; undefined → neutral. */
    gender?: string;
  }): AdviceStream;
  isLakeLockViolation(extraction: Extraction, lakeName: string): boolean;
  getLakeLockRedirect(lakeName: string): string;
  canSpendCredit(user: UserRow): boolean;
  spendCredit(userId: string): Promise<void>;
  chatTurnAllowed(messageCount: number): boolean;
  freezeConversation(id: string): Promise<void>;

  // DB writes
  createConversation(opts: {
    userId: string | null;
    claimToken?: string | null;
    lakeId: string;
    targetTime: Date | null;
    signalsSnapshot: Signals;
  }): Promise<string>;
  persistMessage(opts: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
  }): Promise<void>;
  updateLastActive(conversationId: string): Promise<void>;

  // Analytics
  emit(event: AnalyticsEvent): Promise<void>;

  // Clock (injected for determinism)
  now: Date;
};

// ---------------------------------------------------------------------------
// Result types — discriminated union so callers can handle each case
// ---------------------------------------------------------------------------

export type AskResult =
  | { type: "register_to_continue"; text: string }
  | { type: "chat_limit"; text: string }
  | { type: "topic_refused"; text: string }
  | { type: "lake_unresolved"; text: string }
  | { type: "out_of_credits"; text: string }
  | { type: "lake_lock"; text: string }
  | {
      type: "stream";
      stream: AdviceStream;
      conversationId: string;
      /** Present only for new anon conversations; the route uses this to set the fiska_claim cookie. */
      claimToken?: string;
    };

// L8: gate strings consolidated in ./gate-messages (imported above).

// ---------------------------------------------------------------------------
// handleAsk — the orchestrator
// ---------------------------------------------------------------------------

export async function handleAsk(
  input: AskInput,
  deps: AskHandlerDeps,
): Promise<AskResult> {
  const { message, conversationId } = input;

  // ── Step 1: Resolve identity ────────────────────────────────────────────

  const session = await deps.getSession();
  const userId = session?.user?.id ?? null;
  // H6: claimToken arrives explicitly on the input (route pre-reads the cookie)
  // rather than via a mutated getClaimToken dep.
  const claimToken = input.claimToken ?? null;
  // H2: gendered tilltal only when the IdP supplied a gender at sign-in
  // (CONTEXT.md / ADR-0003); undefined → neutral address (the common case).
  const gender = session?.user?.gender ?? undefined;
  const isAnon = userId === null;

  // ── Step 2: Anon quota gate ─────────────────────────────────────────────
  // An anon user gets exactly 1 free prompt. If they already have a
  // claimToken (issued when they used their free slot) and are trying to
  // continue or start another conversation, block before any Claude call.

  if (isAnon && claimToken !== null) {
    // Anon with a token means they've already used their free slot.
    // H7: emit the register-gate event so the anon→register funnel is visible.
    await deps.emit({ type: "register_gate" });
    return {
      type: "register_to_continue",
      text: ANON_REGISTER_MESSAGE,
    };
  }

  // ── Step 3: Follow-up path — load conversation ──────────────────────────

  let conversation: ConversationRow | null = null;

  if (conversationId) {
    conversation = await deps.getConversation(conversationId);

    // C1 (IDOR): bind the conversation to the caller before any further
    // processing.  Without this, any caller could pass another tenant's
    // conversationId (surfaced via the X-Conversation-Id header) and
    // read/write/poison their conversation + consume their turn quota.
    //   - logged-in caller: conversation.userId must equal userId
    //   - anon caller: conversation must be unclaimed AND its claimToken must
    //     match the caller's cookie token
    // On mismatch return a not-found-style gate (reuse lake_unresolved so the
    // conversation's existence is not revealed) — never a 500.
    if (conversation) {
      const ownsConversation = userId
        ? conversation.userId === userId
        : conversation.userId === null &&
          claimToken !== null &&
          conversation.claimToken === claimToken;
      if (!ownsConversation) {
        return { type: "lake_unresolved", text: LAKE_UNRESOLVED_MESSAGE };
      }
    }

    // Frozen check — return immediately, no Claude call
    if (conversation?.frozen) {
      await deps.emit({ type: "chat_limit_hit", conversationId });
      return { type: "chat_limit", text: CHAT_LIMIT_MESSAGE };
    }

    // Chat-turn limit
    if (conversation) {
      const messageCount = await deps.countUserMessages(conversationId);
      if (!deps.chatTurnAllowed(messageCount)) {
        await deps.freezeConversation(conversationId);
        return { type: "chat_limit", text: CHAT_LIMIT_MESSAGE };
      }
    }
  }

  // ── Step 4: Extract (Haiku) ─────────────────────────────────────────────

  const history = conversationId
    ? await deps.getHistoryMessages(conversationId)
    : [];

  const extraction = await deps.extract(message, history);

  if (!extraction.onTopic) {
    await deps.emit({ type: "topic_refused" });
    return {
      type: "topic_refused",
      text: extraction.refusal ?? "Off-topic.",
    };
  }

  // ── Step 5a: New conversation ───────────────────────────────────────────

  if (!conversationId || !conversation) {
    // Resolve lake
    const lake = await deps.resolveLake(
      extraction.lakeName ?? "",
      extraction.municipality,
    );

    if (!lake) {
      await deps.emit({ type: "lake_unresolved" });
      return { type: "lake_unresolved", text: LAKE_UNRESOLVED_MESSAGE };
    }

    // Credit gate — load user row for logged-in users
    let userRow: UserRow | null = null;
    if (userId) {
      userRow = await deps.getUserRow(userId);
    }

    const creditUser = userRow ?? { isPaid: false, creditsUsed: 0 };
    if (!deps.canSpendCredit(creditUser)) {
      // H7: emit so credit-exhaustion is visible in analytics.
      await deps.emit({ type: "out_of_credits" });
      return { type: "out_of_credits", text: OUT_OF_CREDITS_MESSAGE };
    }

    // Build signals
    // C1 fix: the Extractor returns Swedish free-text time ("ikväll", "imorgon",
    // "på lördag") which new Date() cannot parse → Invalid Date.  Guard: if the
    // parsed date is invalid fall back to deps.now.  Proper Swedish relative-time
    // resolution (e.g. via a date-fns locale) is a follow-up task.
    const parsedTime = extraction.time ? new Date(extraction.time) : null;
    const targetTime =
      parsedTime !== null && !Number.isNaN(parsedTime.getTime())
        ? parsedTime
        : deps.now;

    // I1 fix: use formatLabel for the full disambiguation label in Signals
    // ("name (municipality, county)" per CONTEXT.md / ADR-0002).  The bare
    // lake name for the lake-lock comparison is stored in signalsSnapshot as
    // bareLakeName (set by buildSignals), decoupled from the formatted label.
    // Unnamed bodies fall back to lake.id.
    const lakeWithLabel: Lake & { label: string } = {
      ...lake,
      label: lake.name
        ? formatLabel({
            name: lake.name,
            municipality: lake.municipality,
            county: lake.county,
          })
        : lake.id,
    };

    const signals = await deps.buildSignals({
      lake: lakeWithLabel,
      targetTime,
      now: deps.now,
    });

    // Generate a claimToken for new anon conversations so the route can
    // set the fiska_claim cookie (enabling the anon quota gate on 2nd prompts).
    const newAnonClaimToken = isAnon ? randomUUID() : null;

    // Create conversation row with frozen snapshot
    const newConvId = await deps.createConversation({
      userId,
      claimToken: newAnonClaimToken,
      lakeId: lake.id,
      targetTime,
      signalsSnapshot: signals,
    });

    // Spend credit and emit lake_resolved.
    // M2: the credit is committed here, BEFORE adviseFirst/the stream succeeds
    // (ADR-0004: Credit = fresh fetch + Sonnet).  A failed Sonnet call after
    // this point burns the credit.  A clean refund needs a stream-result
    // callback back into the handler (the stream resolves in route.ts, after
    // this function returns) — [~] deferred: refund needs stream-result
    // callback into handler.  Observability is covered: route.ts emits a
    // `persistence_failure` analytics event if the post-stream path fails, so
    // the credit/stream discrepancy is at least visible.
    // TODO(refund): thread a finalMessage()-failure callback into handleAsk so
    // a failed first-turn stream can refund the spent credit.
    if (userId) {
      await deps.spendCredit(userId);
    }
    await deps.emit({ type: "lake_resolved", lakeId: lake.id });

    // Stream first advice (Sonnet)
    const adviceStream = deps.adviseFirst({
      signals,
      message,
      history,
      gender,
    });

    return {
      type: "stream",
      stream: adviceStream,
      conversationId: newConvId,
      // Surface the claimToken for new anon conversations so route.ts can
      // set the fiska_claim cookie — this is the plumbing that was missing.
      ...(newAnonClaimToken !== null ? { claimToken: newAnonClaimToken } : {}),
    };
  }

  // ── Step 5b: Follow-up ──────────────────────────────────────────────────
  // At this point conversationId and conversation are both non-null
  // (we only reach here when !(!conversationId || !conversation))
  const followConvId = conversationId as string;

  const snapshot = conversation.signalsSnapshot;
  if (!snapshot) {
    // Shouldn't happen in normal flow — treat as fatal gate failure
    return { type: "lake_unresolved", text: LAKE_UNRESOLVED_MESSAGE };
  }

  // Lake-lock check.
  // M1: only apply the lock when a BARE lake name is available.  When only a
  // formatted label is present (legacy row without bareLakeName), comparing
  // the user's bare lake name against the full label would never match → a
  // false lock that blocks legitimate follow-ups.  Skip the lock in that case.
  const lockKey = conversation.lakeName ?? null;
  if (lockKey !== null && deps.isLakeLockViolation(extraction, lockKey)) {
    const redirect = deps.getLakeLockRedirect(lockKey);
    // H7: emit so lake-lock redirects are visible in analytics.
    await deps.emit({ type: "lake_lock", conversationId: followConvId });
    return { type: "lake_lock", text: redirect };
  }

  // Count turns for windingDown.  M3: countUserMessages returns only the
  // already-persisted user rows (the in-flight turn is persisted post-stream),
  // so add 1 to make turnIndex INCLUSIVE of the current turn.  This makes
  // windingDown (turnIndex >= 15 in advise.ts) flip exactly at turn 15 per
  // CONTEXT, rather than one turn late.
  const turnIndex = (await deps.countUserMessages(followConvId)) + 1;

  // Stream follow-up advice (Haiku)
  const followStream = deps.adviseFollowup({
    snapshot,
    message,
    history,
    turnIndex,
    gender,
  });

  return {
    type: "stream",
    stream: followStream,
    conversationId: followConvId,
  };
}
