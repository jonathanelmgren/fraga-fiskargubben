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
import type { Signals } from "@/lib/signals/types";
import { CHAT_LIMIT_MESSAGE } from "./quota";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AskInput = {
  message: string;
  conversationId?: string;
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
  getSession(): Promise<{ user: { id: string } } | null>;
  getClaimToken(): string | null;

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
  }): AdviceStream;
  adviseFollowup(params: {
    snapshot: Signals;
    message: string;
    history: HistoryMessage[];
    turnIndex: number;
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

// ---------------------------------------------------------------------------
// In-persona gate messages (Swedish, Fiskargubben voice)
// ---------------------------------------------------------------------------

const ANON_REGISTER_MESSAGE =
  "Registrera dig för att fortsätta — anon-fisket är ett gratisprova, grabben.";

const LAKE_UNRESOLVED_MESSAGE =
  "kände inte igen sjön du nämnde — kan du skriva sjönamnet tydligare, eventuellt med kommunen?";

const OUT_OF_CREDITS_MESSAGE =
  "du har förbrukat dina gratiskrediter — uppgradera för att fiska vidare.";

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
  const claimToken = deps.getClaimToken();
  const isAnon = userId === null;

  // ── Step 2: Anon quota gate ─────────────────────────────────────────────
  // An anon user gets exactly 1 free prompt. If they already have a
  // claimToken (issued when they used their free slot) and are trying to
  // continue or start another conversation, block before any Claude call.

  if (isAnon && claimToken !== null) {
    // Anon with a token means they've already used their free slot
    return {
      type: "register_to_continue",
      text: ANON_REGISTER_MESSAGE,
    };
  }

  // ── Step 3: Follow-up path — load conversation ──────────────────────────

  let conversation: ConversationRow | null = null;

  if (conversationId) {
    conversation = await deps.getConversation(conversationId);

    // Frozen check — return immediately, no Claude call
    if (conversation?.frozen) {
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
      return { type: "out_of_credits", text: OUT_OF_CREDITS_MESSAGE };
    }

    // Build signals
    const targetTime = extraction.time ? new Date(extraction.time) : deps.now;

    const lakeWithLabel: Lake & { label: string } = {
      ...lake,
      label: lake.name ?? lake.id,
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

    // Spend credit and emit lake_resolved
    if (userId) {
      await deps.spendCredit(userId);
    }
    await deps.emit({ type: "lake_resolved", lakeId: lake.id });

    // Stream first advice (Sonnet)
    const adviceStream = deps.adviseFirst({
      signals,
      message,
      history,
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

  // Lake-lock check
  const lockedLakeName = conversation.lakeName ?? snapshot.lake ?? "";
  if (deps.isLakeLockViolation(extraction, lockedLakeName)) {
    const redirect = deps.getLakeLockRedirect(lockedLakeName);
    return { type: "lake_lock", text: redirect };
  }

  // Count turns for windingDown
  const turnIndex = await deps.countUserMessages(followConvId);

  // Stream follow-up advice (Haiku)
  const followStream = deps.adviseFollowup({
    snapshot,
    message,
    history,
    turnIndex,
  });

  return {
    type: "stream",
    stream: followStream,
    conversationId: followConvId,
  };
}
