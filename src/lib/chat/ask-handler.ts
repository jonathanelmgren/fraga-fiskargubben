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
import type { Lake, ResolveResult } from "@/lib/lakes/resolve";
import { formatLabel } from "@/lib/lakes/resolve-helpers";
import type { Signals } from "@/lib/signals/types";
import {
  ANON_REGISTER_MESSAGE,
  CANNED_REFUSAL,
  CHAT_LIMIT_MESSAGE,
  LAKE_UNRESOLVED_MESSAGE,
  lakeAmbiguousMessage,
  OUT_OF_CREDITS_MESSAGE,
} from "./gate-messages";
import { resolveSwedishTime } from "./swedish-time";

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
  /**
   * M9: the BARE lake name (e.g. "Tolken", not the "name (municipality,
   * county)" label) used as the lake-lock key on follow-ups. It is NOT a
   * column on the conversation row — the route digs it out of the frozen
   * signalsSnapshot jsonb (snapshot.bareLakeName). null for legacy rows whose
   * snapshot predates bareLakeName → the handler skips the lock entirely.
   */
  bareLakeName?: string | null;
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
  resolveLake(name: string, municipality?: string): Promise<ResolveResult>;
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
  /**
   * Atomically spends a credit; returns false when the guarded UPDATE matched
   * no row (user already at/over the free limit) — the caller treats false as
   * out-of-credits to close the check-then-spend race (E5).
   */
  spendCredit(userId: string): Promise<boolean>;
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
  // M8: persistMessage / updateLastActive are intentionally NOT on this
  // interface. handleAsk never persists turns — that is the route's
  // fire-and-forget post-stream job (route.ts after()/persistTurns), which
  // holds its own DB writers. Keeping them off the orchestrator's deps stops a
  // reader assuming handleAsk writes turns.

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
  | { type: "lake_ambiguous"; text: string }
  | { type: "out_of_credits"; text: string }
  | { type: "lake_lock"; text: string }
  | {
      type: "stream";
      stream: AdviceStream;
      conversationId: string;
      /** Present only for new anon conversations; the route uses this to set the fiska_claim cookie. */
      claimToken?: string;
      /**
       * Set to the user id ONLY when a credit was actually spent for this
       * first-turn stream (ADR-0004). The route refunds it if the Sonnet stream
       * fails post-return — a failed answer must not consume a credit. Absent on
       * follow-ups and free/anon turns (nothing to refund).
       */
      refundUserId?: string;
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
  // M3: count the persisted user-message rows ONCE per follow-up. It feeds both
  // the chat-turn gate (chatTurnAllowed) and turnIndex/windingDown; nothing is
  // inserted between the two reads (the in-flight turn is persisted post-stream
  // via route.ts after()), so a single query is correct and saves a round-trip.
  let messageCount: number | null = null;

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

    // Frozen check — return immediately, no Claude call.
    // M6: emit chat_limit_RETRY here, NOT chat_limit_hit. chat_limit_hit is
    // emitted exactly once, by freezeConversation on the actual transition (so
    // a dashboard counting it measures "chats that hit the limit", per
    // ADR-0005). Every later attempt against an already-frozen conversation is
    // a retry — a distinct event so it doesn't over-count the transition.
    if (conversation?.frozen) {
      await deps.emit({ type: "chat_limit_retry", conversationId });
      return { type: "chat_limit", text: CHAT_LIMIT_MESSAGE };
    }

    // Chat-turn limit
    if (conversation) {
      messageCount = await deps.countUserMessages(conversationId);
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
      // L: Swedish persona fallback (CANNED_REFUSAL) instead of an English
      // "Off-topic." string on an all-Swedish surface.
      text: extraction.refusal ?? CANNED_REFUSAL,
    };
  }

  // ── Step 5a: New conversation ───────────────────────────────────────────

  if (!conversationId || !conversation) {
    // Resolve lake. resolveLake distinguishes "no such name" from "several
    // lakes share this name" so we can prompt precisely (less guessing) —
    // an ambiguous name asks WHICH municipality rather than a generic reprompt.
    const resolved = await deps.resolveLake(
      extraction.lakeName ?? "",
      extraction.municipality,
    );

    if (resolved.kind === "ambiguous") {
      const municipalities = resolved.candidates.map((c) => c.municipality);
      await deps.emit({ type: "lake_ambiguous" });
      return {
        type: "lake_ambiguous",
        text: lakeAmbiguousMessage(resolved.candidates[0].name, municipalities),
      };
    }

    if (resolved.kind === "none") {
      await deps.emit({ type: "lake_unresolved" });
      return { type: "lake_unresolved", text: LAKE_UNRESOLVED_MESSAGE };
    }

    const lake = resolved.lake;

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
    // Issue #7: the Extractor returns Swedish free-text time ("ikväll",
    // "imorgon", "imorgon kväll", "på lördag", "kl 19") which new Date() cannot
    // parse → Invalid Date → silently NOW (forecast computed for the wrong
    // moment).  resolveSwedishTime resolves those relative expressions against
    // the injected clock (deps.now).  Anything it can't understand returns null;
    // we then still tolerate a genuine ISO string via new Date() before
    // defaulting to deps.now — preserving the original valid-or-now fallback.
    const resolvedTime = resolveSwedishTime(extraction.time, deps.now);
    const isoTime = extraction.time ? new Date(extraction.time) : null;
    const isoParsed = isoTime !== null && !Number.isNaN(isoTime.getTime());
    const targetTime = resolvedTime ?? (isoParsed ? isoTime : deps.now);
    // L-ah1: even with the Swedish parser, a time we still can't resolve falls
    // back to `now` silently.  Emit it (only when a time was actually given but
    // neither the Swedish parser nor ISO parsing understood it) so the residual
    // fallback rate stays visible in analytics.
    if (extraction.time && resolvedTime === null && !isoParsed) {
      await deps.emit({
        type: "time_parse_fallback",
        payload: { time: extraction.time },
      });
    }

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
    // (ADR-0004: Credit = fresh fetch + a successful Sonnet answer). The stream
    // resolves in route.ts AFTER this function returns, so a failed answer can't
    // be refunded inline. Instead we surface `refundUserId` on the stream result
    // — the route's post-stream persistTurns refunds the credit when
    // finalMessage() rejects, so a failed first-turn answer never consumes one.
    //
    // E5 (check-then-spend race): spendCredit is a GUARDED atomic UPDATE that
    // returns false when the user has, since the canSpendCredit pre-check,
    // exhausted the free limit (e.g. a concurrent request raced ahead). Treat
    // a false return as out-of-credits so two concurrent free-tier prompts can
    // never both stream.
    let refundUserId: string | undefined;
    if (userId) {
      const spent = await deps.spendCredit(userId);
      if (!spent) {
        await deps.emit({ type: "out_of_credits" });
        return { type: "out_of_credits", text: OUT_OF_CREDITS_MESSAGE };
      }
      refundUserId = userId;
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
      // Refund target: only when a credit was actually spent above.
      ...(refundUserId !== undefined ? { refundUserId } : {}),
    };
  }

  // ── Step 5b: Follow-up ──────────────────────────────────────────────────
  // At this point conversationId and conversation are both non-null
  // (we only reach here when !(!conversationId || !conversation)), so derive
  // the id from the (typed, non-null) conversation row rather than casting.
  const followConvId = conversation.id;

  const snapshot = conversation.signalsSnapshot;
  if (!snapshot) {
    // The lake WAS resolved on this conversation; a missing frozen snapshot is
    // an internal data anomaly (e.g. a write that never landed), NOT a failure
    // to recognise the lake. Emit a persistence_failure so it is observable
    // instead of being silently rendered as a "lake not recognised" message.
    // We still return a sensible gate to the user (we can't continue without a
    // snapshot); reuse lake_unresolved so as not to invent a new gate type.
    await deps.emit({
      type: "persistence_failure",
      conversationId: followConvId,
      payload: { reason: "missing_signals_snapshot" },
    });
    return { type: "lake_unresolved", text: LAKE_UNRESOLVED_MESSAGE };
  }

  // Lake-lock check.
  // M1: only apply the lock when a BARE lake name is available.  When only a
  // formatted label is present (legacy row without bareLakeName), comparing
  // the user's bare lake name against the full label would never match → a
  // false lock that blocks legitimate follow-ups.  Skip the lock in that case.
  const lockKey = conversation.bareLakeName ?? null;
  if (lockKey !== null && deps.isLakeLockViolation(extraction, lockKey)) {
    const redirect = deps.getLakeLockRedirect(lockKey);
    // H7: emit so lake-lock redirects are visible in analytics.
    await deps.emit({ type: "lake_lock", conversationId: followConvId });
    return { type: "lake_lock", text: redirect };
  }

  // Count turns for windingDown.  M3: reuse the messageCount already read in
  // Step 3 (a follow-up always passes through the chat-turn gate, which sets
  // it) rather than re-querying — the value can't have changed since (nothing
  // is inserted mid-request). Fall back to a fresh read only if it is somehow
  // unset. countUserMessages returns only the already-persisted user rows (the
  // in-flight turn is persisted post-stream), so add 1 to make turnIndex
  // INCLUSIVE of the current turn — windingDown (turnIndex >= 15 in advise.ts)
  // then flips exactly at turn 15 per CONTEXT, rather than one turn late.
  const persistedUserCount =
    messageCount ?? (await deps.countUserMessages(followConvId));
  const turnIndex = persistedUserCount + 1;

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
