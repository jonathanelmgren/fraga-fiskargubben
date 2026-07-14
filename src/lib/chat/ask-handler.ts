/**
 * ask-handler.ts — orchestration logic for POST /api/ask.
 *
 * Pure function with injected dependencies so it can be unit-tested without a
 * real server, DB, or Claude API. The route wires real deps and maps the
 * result to a Response.
 *
 * Rebuild (2026-07-03 spec): conversations carry a lake-resolution lifecycle:
 *
 *   lake_pending ──(Haiku confident)──────────► resolved ◄─────┐
 *        │ ▲                                        │          │
 *        │ └── clarify round (free, Haiku only)     │   lake switch (free
 *        └──(3 strikes or noSuchLake)──► unresolved_area ──────┘  re-resolution)
 *
 * Gate ordering:
 *  1. Identity: session OR anon claim token
 *  2. Anon quota gate — blocks NEW conversations only (follow-ups on the
 *     anon's own conversation are allowed; the clarify loop needs them)
 *  3. Chat-turn limit / frozen check (follow-ups; free tier only — paid
 *     users and admins bypass the limit)
 *  4. Extractor (Haiku) → topic gate (loosened: outdoors/weather is on-topic)
 *  5. By status:
 *     - lake_pending → candidate SQL + Haiku resolver. Confident → transition
 *       to resolved; strikes/noSuchLake → transition to unresolved_area;
 *       otherwise a free clarify round.
 *     - resolved / unresolved_area → lake switch check (a newly named lake
 *       re-enters resolution, free) → otherwise adviseFollowup with the
 *       frozen snapshot
 *
 * THE CREDIT IS SPENT EXACTLY ONCE — at the transition out of lake_pending
 * (whether to resolved or unresolved_area), immediately before the first
 * Sonnet answer. All pre-transition turns are Haiku-only and free. Admins
 * never spend credits.
 */

import { randomUUID } from "node:crypto";
import type { AnalyticsEvent } from "@/lib/analytics/events";
import { llmUsagePayload } from "@/lib/analytics/llm-cost";
import type { Extraction, HistoryMessage } from "@/lib/chat/extractor";
import type { CandidateLake, UserLocation } from "@/lib/lakes/candidates";
import type { HaikuResolution } from "@/lib/lakes/haiku-resolver";
import {
  MAX_RESOLVE_ATTEMPTS,
  RESOLVE_CONFIDENCE_THRESHOLD,
} from "@/lib/lakes/haiku-resolver";
import type { Lake } from "@/lib/lakes/resolve";
import { formatLabel } from "@/lib/lakes/resolve-helpers";
import type { Signals } from "@/lib/signals/types";
import { formatStockholmLocal } from "@/lib/time/stockholm";
import {
  ANON_REGISTER_MESSAGE,
  CANNED_REFUSAL,
  CHAT_LIMIT_MESSAGE,
  COST_BUDGET_MESSAGE,
  FAIR_USE_MESSAGE,
  LAKE_CLARIFY_FALLBACK,
  LAKE_UNRESOLVED_MESSAGE,
  OUT_OF_CREDITS_MESSAGE,
  ortClarifyMessage,
  switchGiveUpMessage,
} from "./gate-messages";
import { resolveSwedishTime } from "./swedish-time";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AskInput = {
  message: string;
  conversationId?: string;
  /**
   * The anon claim token pre-read from the request cookie. Null for logged-in
   * callers or anon callers without a token yet.
   */
  claimToken?: string | null;
  /**
   * Browser geolocation forwarded by the client on the FIRST prompt, when the
   * user granted it. Stored on the conversation; used as a resolution bias
   * and the unresolved-area coords fallback. A place named in the prompt
   * always outweighs it.
   */
  location?: UserLocation;
  /**
   * HMAC of the client IP (route-computed) for anon callers. Caps anon
   * conversations per IP per window — the incognito loophole around the
   * one-free-conversation claim cookie. Null/undefined = no determinable IP
   * (never blocks; same stance as the signup guard).
   */
  anonIpHash?: string | null;
};

/** Max anon conversations per IP hash per rolling window. */
export const ANON_IP_CONVERSATION_LIMIT = 1;

/** Rolling window for ANON_IP_CONVERSATION_LIMIT. */
export const ANON_IP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Fair-use BURST cap for PAID users: max NEW conversations per rolling day.
 * Stops a runaway (script, shared account) from draining the annual cost
 * budget below in a weekend — the lock is short, the budget stays intact for
 * the rest of the subscription year. Follow-up turns are NOT capped (Haiku,
 * cheap). Admins bypass.
 */
export const PAID_FAIR_USE_CONVERSATION_LIMIT = 20;

/** Rolling window for PAID_FAIR_USE_CONVERSATION_LIMIT. */
export const PAID_FAIR_USE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Hard COST budget per paid account per rolling year — the "this customer can
 * never cost us money" ceiling, measured against the actual llm_usage cost
 * analytics (see lib/analytics/llm-cost.ts).
 *
 * Economics: premium is 89 SEK/yr; Stripe fees eat ~3.4 SEK → ~85.6 SEK net.
 * Budget 70 SEK guarantees ≥ ~15 SEK margin per subscriber. Converted to USD
 * (costUsd is what we store) at a deliberately WEAK-krona guard rate, so an FX
 * swing can't push a capped account past 70 SEK.
 *
 * ~70 SEK / 11 ≈ $6.36 ≈ ~180 chats/yr at the current ~$0.035/chat.
 */
export const PAID_ANNUAL_COST_BUDGET_SEK = 70;
/** Conservative (weak-krona) SEK per USD for the budget conversion. */
export const SEK_PER_USD_GUARD = 11;
export const PAID_ANNUAL_COST_BUDGET_USD =
  PAID_ANNUAL_COST_BUDGET_SEK / SEK_PER_USD_GUARD;

/**
 * Fallback window for the cost budget: users with an active subscription are
 * anchored to its periodStart (renewal resets the budget — see route.ts);
 * this rolling window covers rows without one (admin/dev accounts).
 */
export const PAID_COST_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

export type ConversationStatus =
  | "lake_pending"
  | "resolved"
  | "unresolved_area";

/** Shape of a conversation row from the DB (only fields we need). */
export type ConversationRow = {
  id: string;
  userId: string | null;
  claimToken?: string | null;
  frozen: boolean;
  status: ConversationStatus;
  resolveAttempts: number;
  userLat: number | null;
  userLon: number | null;
  signalsSnapshot?: Signals | null;
  lakeId?: string | null;
  /**
   * The BARE lake name used as the lake-lock key on follow-ups, dug out of
   * the frozen signalsSnapshot jsonb (snapshot.bareLakeName). null for area
   * conversations and legacy rows → the handler skips the lock.
   */
  bareLakeName?: string | null;
  /**
   * In-flight resolution target (conversations.pendingLakeName). Backs the
   * strike-reset pivot rule and switch-clarify continuation. Null on legacy
   * rows and when no clarify is in flight.
   */
  pendingLakeName?: string | null;
};

/** Minimal user row for quota checks. */
export type UserRow = {
  isPaid: boolean;
  creditsUsed: number;
};

/** Minimal stream interface returned by advise functions. */
export type AdviceStream = {
  toReadableStream(): ReadableStream;
  /**
   * model + usage are present on the real Anthropic finalMessage() payload;
   * optional here so test fakes without them keep working. persist-turns uses
   * them for the `llm_usage` cost event.
   */
  finalMessage(): Promise<{
    content: Array<{ type: string; text?: string }>;
    model?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    };
  }>;
};

// ---------------------------------------------------------------------------
// AskHandlerDeps — all injectable dependencies
// ---------------------------------------------------------------------------

export type AskHandlerDeps = {
  // Identity
  getSession(): Promise<{
    user: { id: string; gender?: string | null; isAdmin: boolean };
  } | null>;

  // DB reads
  getConversation(id: string): Promise<ConversationRow | null>;
  countUserMessages(conversationId: string): Promise<number>;
  getHistoryMessages(conversationId: string): Promise<HistoryMessage[]>;
  getUserRow(userId: string): Promise<UserRow | null>;

  // Leaf modules
  extract(message: string, history: HistoryMessage[]): Promise<Extraction>;

  // Lake resolution (two-stage)
  candidateLakes(
    name: string,
    userLoc?: UserLocation,
  ): Promise<CandidateLake[]>;
  resolveLakeWithHaiku(params: {
    message: string;
    lakeName?: string;
    municipality?: string;
    userLoc?: UserLocation;
    candidates: CandidateLake[];
    history?: HistoryMessage[];
  }): Promise<HaikuResolution>;

  // Signals
  buildSignals(input: {
    lake: Lake & { label: string };
    targetTime: Date;
    now: Date;
  }): Promise<Signals>;
  buildAreaSignals(input: {
    label: string;
    lat: number;
    lon: number;
    askedLakeName?: string;
    askedWaterKind?: Signals["askedWaterKind"];
    nearbyLakes?: Signals["nearbyLakes"];
    targetTime: Date;
    now: Date;
  }): Promise<Signals>;

  // Advice
  adviseFirst(params: {
    signals: Signals;
    message: string;
    history: HistoryMessage[];
    gender?: string;
  }): AdviceStream;
  adviseFollowup(params: {
    snapshot: Signals;
    message: string;
    history: HistoryMessage[];
    turnIndex: number;
    gender?: string;
  }): AdviceStream;
  // Quota
  canSpendCredit(user: UserRow, opts?: { isAdmin?: boolean }): boolean;
  /**
   * Atomically spends a credit; false when the guarded UPDATE matched no row
   * (raced past the free limit) — caller treats false as out-of-credits (E5).
   */
  spendCredit(userId: string): Promise<boolean>;
  chatTurnAllowed(
    messageCount: number,
    opts?: { isAdmin?: boolean; isPaid?: boolean },
  ): boolean;
  freezeConversation(id: string): Promise<void>;

  // DB writes (lifecycle)
  createPendingConversation(opts: {
    userId: string | null;
    claimToken?: string | null;
    userLat?: number | null;
    userLon?: number | null;
    /** Short Haiku-extracted headline for the drawer, e.g. "Abborre i Vättern". */
    title?: string | null;
    anonIpHash?: string | null;
  }): Promise<string>;
  /**
   * Anon conversations created from this IP hash within ANON_IP_WINDOW_MS.
   * Optional so tests without the abuse guard keep working; absent = no gate.
   */
  countRecentAnonConversationsByIp?(ipHash: string): Promise<number>;
  /**
   * Conversations created by this user within PAID_FAIR_USE_WINDOW_MS —
   * backs the paid fair-use burst cap. Optional: absent = no gate.
   */
  countRecentConversationsByUser?(userId: string): Promise<number>;
  /**
   * Summed llm_usage costUsd attributed to this user's conversations within
   * PAID_COST_WINDOW_MS — backs the annual cost budget. Optional: absent =
   * no gate.
   */
  getRecentLlmCostUsdByUser?(userId: string): Promise<number>;
  transitionConversation(opts: {
    id: string;
    status: Extract<ConversationStatus, "resolved" | "unresolved_area">;
    lakeId: string | null;
    targetTime: Date | null;
    signalsSnapshot: Signals;
    /** Replaces the drawer headline on a lake switch; omitted = keep. */
    title?: string;
  }): Promise<void>;
  /**
   * Records one clarify round in a single write: resolveAttempts is set to
   * the ABSOLUTE value `attempts` (not incremented — the pivot rule can reset
   * it) and pendingLakeName to the current resolution target.
   */
  recordClarifyRound(
    id: string,
    opts: { attempts: number; pendingLakeName: string | null },
  ): Promise<void>;

  // Analytics
  emit(event: AnalyticsEvent): Promise<void>;

  // Clock (injected for determinism)
  now: Date;
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type AskResult =
  | { type: "register_to_continue"; text: string }
  | { type: "chat_limit"; text: string }
  /** Paid fair-use cap hit — the route maps this to HTTP 429. */
  | { type: "rate_limited"; text: string }
  | { type: "topic_refused"; text: string }
  | { type: "lake_unresolved"; text: string }
  | { type: "out_of_credits"; text: string }
  | {
      /**
       * A free clarify round: the resolver was not confident enough and asks
       * the user to be more specific. The route persists BOTH turns (user
       * message + this text) so the next resolver round sees the history, and
       * sets the claim cookie for brand-new anon conversations.
       */
      type: "clarify";
      text: string;
      conversationId: string;
      claimToken?: string;
    }
  | {
      type: "stream";
      stream: AdviceStream;
      conversationId: string;
      /** Present only for new anon conversations (route sets fiska_claim). */
      claimToken?: string;
      /**
       * Set ONLY when a credit was actually spent for this first-turn stream —
       * the route refunds it if the Sonnet stream fails post-return.
       */
      refundUserId?: string;
      /**
       * Compact badge payload for the chat UI (lake/area label + key
       * conditions), sent as the X-Signals response header before the stream.
       */
      badges?: SignalBadges;
    };

/** What the chat UI shows as badges above the thread. */
export type SignalBadges = {
  lake: string;
  status: Extract<ConversationStatus, "resolved" | "unresolved_area">;
  airTempC?: number;
  windMs?: number;
  waterTempC?: number;
};

export function toBadges(
  signals: Signals,
  status: SignalBadges["status"],
): SignalBadges {
  return {
    // Display rule: bare lake name only ("Åsunden", not "Åsunden (Borås,
    // Västra Götaland)"). The full label stays in signals.lake for the LLM
    // and area labels ("trakten kring …") have no bare name to prefer.
    lake: signals.bareLakeName ?? signals.lake,
    status,
    ...(signals.airTempC ? { airTempC: signals.airTempC.value } : {}),
    ...(signals.windMs ? { windMs: signals.windMs.value } : {}),
    ...(signals.waterTempC ? { waterTempC: signals.waterTempC.value } : {}),
  };
}

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
  const isAdmin = session?.user?.isAdmin ?? false;
  const claimToken = input.claimToken ?? null;
  const gender = session?.user?.gender ?? undefined;
  const isAnon = userId === null;

  // ── Step 2: Follow-up path — load conversation ──────────────────────────

  let conversation: ConversationRow | null = null;
  let messageCount: number | null = null;

  if (conversationId) {
    conversation = await deps.getConversation(conversationId);

    // C1 (IDOR): bind the conversation to the caller before any further
    // processing. Logged-in: userId must match. Anon: unclaimed AND the
    // caller's cookie token must match. On mismatch return a not-found-style
    // gate (existence not revealed) — never a 500.
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

    // Frozen check — return immediately, no Claude call. (chat_limit_retry is
    // distinct from chat_limit_hit — see freezeConversation.)
    if (conversation?.frozen) {
      await deps.emit({ type: "chat_limit_retry", conversationId });
      return { type: "chat_limit", text: CHAT_LIMIT_MESSAGE };
    }

    // Chat-turn limit (free tier only — paid users and admins bypass)
    if (conversation) {
      messageCount = await deps.countUserMessages(conversationId);
      const isPaid =
        userId && !isAdmin
          ? ((await deps.getUserRow(userId))?.isPaid ?? false)
          : false;
      if (!deps.chatTurnAllowed(messageCount, { isAdmin, isPaid })) {
        await deps.freezeConversation(conversationId);
        return { type: "chat_limit", text: CHAT_LIMIT_MESSAGE };
      }
    }
  }

  // ── Step 3: Anon quota gate — NEW conversations only ────────────────────
  // An anon user gets exactly 1 free conversation. Follow-ups on their own
  // conversation (matched via the claim cookie above) stay allowed — the
  // clarify loop and ordinary follow-up turns need them. Only a SECOND
  // conversation is blocked.

  if (isAnon && claimToken !== null && !conversation) {
    // reason distinguishes this (claim cookie already used) from the IP-hash
    // gate below, which carries reason: "anon_ip_limit".
    await deps.emit({
      type: "register_gate",
      payload: { reason: "anon_claim_used" },
    });
    return { type: "register_to_continue", text: ANON_REGISTER_MESSAGE };
  }

  // IP-hash cap for anon NEW conversations: incognito wipes the claim
  // cookie, but the IP hash survives. Follow-ups are unaffected. No
  // determinable IP → no gate (same stance as the signup guard).
  if (
    isAnon &&
    !conversation &&
    input.anonIpHash &&
    deps.countRecentAnonConversationsByIp
  ) {
    const recent = await deps.countRecentAnonConversationsByIp(
      input.anonIpHash,
    );
    if (recent >= ANON_IP_CONVERSATION_LIMIT) {
      await deps.emit({
        type: "register_gate",
        payload: { reason: "anon_ip_limit" },
      });
      return { type: "register_to_continue", text: ANON_REGISTER_MESSAGE };
    }
  }

  // ── Step 4: Extract (Haiku) ─────────────────────────────────────────────

  const history = conversation
    ? await deps.getHistoryMessages(conversation.id)
    : [];

  const extraction = await deps.extract(message, history);

  if (!extraction.onTopic) {
    // Refusals on brand-new prompts have no conversation yet — the usage is
    // still recorded (cost analytics), just unattributed.
    if (extraction.usage) {
      await deps.emit({
        type: "llm_usage",
        ...(conversation ? { conversationId: conversation.id } : {}),
        payload: llmUsagePayload("extract", extraction.usage),
      });
    }
    // The refused prompt is captured in the payload — the refusal path never
    // persists a message row, so without this the "what are people actually
    // trying?" question is unanswerable. `message` is already length-capped at
    // the route boundary (MAX_MESSAGE_LENGTH), so the payload stays bounded.
    await deps.emit({
      type: "topic_refused",
      ...(conversation ? { conversationId: conversation.id } : {}),
      payload: {
        prompt: message,
        ...(userId ? { userId } : {}),
      },
    });
    return {
      type: "topic_refused",
      text: extraction.refusal ?? CANNED_REFUSAL,
    };
  }

  // ── Step 5: New conversation → create a pending row ─────────────────────

  let newAnonClaimToken: string | null = null;

  if (!conversation) {
    // Cheap credit pre-check BEFORE burning Haiku clarify rounds the user
    // can never cash in. The authoritative guarded spend happens at the
    // transition; this only prevents a pointless pending conversation.
    if (userId && !isAdmin) {
      const userRow = await deps.getUserRow(userId);
      const creditUser = userRow ?? { isPaid: false, creditsUsed: 0 };
      if (!deps.canSpendCredit(creditUser, { isAdmin })) {
        // No conversation gets created — record the extract cost unattributed.
        if (extraction.usage) {
          await deps.emit({
            type: "llm_usage",
            payload: llmUsagePayload("extract", extraction.usage),
          });
        }
        await deps.emit({
          type: "out_of_credits",
          payload: { userId, reason: "pre_check" },
        });
        return { type: "out_of_credits", text: OUT_OF_CREDITS_MESSAGE };
      }

      // Paid fair-use gates: "unlimited" is fair-use limited (ToS §3). Both
      // fire on NEW conversations only — the cost driver is chats started
      // (one Sonnet answer each), not follow-up turns.
      if (creditUser.isPaid) {
        // Burst cap: short lock, protects the annual budget from a runaway.
        if (deps.countRecentConversationsByUser) {
          const recent = await deps.countRecentConversationsByUser(userId);
          if (recent >= PAID_FAIR_USE_CONVERSATION_LIMIT) {
            await deps.emit({
              type: "fair_use_limit",
              payload: { userId, reason: "burst", recent },
            });
            return { type: "rate_limited", text: FAIR_USE_MESSAGE };
          }
        }

        // Cost budget: the account's actual tracked LLM spend must never
        // exceed what the subscription earns (35 SEK/yr of the 39 SEK price).
        if (deps.getRecentLlmCostUsdByUser) {
          const costUsd = await deps.getRecentLlmCostUsdByUser(userId);
          if (costUsd >= PAID_ANNUAL_COST_BUDGET_USD) {
            await deps.emit({
              type: "fair_use_limit",
              payload: { userId, reason: "cost_budget", costUsd },
            });
            return { type: "rate_limited", text: COST_BUDGET_MESSAGE };
          }
        }
      }
    }

    newAnonClaimToken = isAnon ? randomUUID() : null;
    const newConvId = await deps.createPendingConversation({
      userId,
      claimToken: newAnonClaimToken,
      userLat: input.location?.lat ?? null,
      userLon: input.location?.lon ?? null,
      title: extraction.title ?? null,
      anonIpHash: isAnon ? (input.anonIpHash ?? null) : null,
    });
    conversation = {
      id: newConvId,
      userId,
      claimToken: newAnonClaimToken,
      frozen: false,
      status: "lake_pending",
      resolveAttempts: 0,
      userLat: input.location?.lat ?? null,
      userLon: input.location?.lon ?? null,
      signalsSnapshot: null,
      lakeId: null,
      bareLakeName: null,
      pendingLakeName: null,
    };
  }

  // Cost analytics: attribute the extractor call to the conversation (which
  // exists by now, whether loaded or just created).
  if (extraction.usage) {
    await deps.emit({
      type: "llm_usage",
      conversationId: conversation.id,
      payload: llmUsagePayload("extract", extraction.usage),
    });
  }

  // ── Step 6: Branch on lifecycle status ──────────────────────────────────

  if (conversation.status === "lake_pending") {
    return resolvePendingConversation({
      conversation,
      extraction,
      message,
      history,
      userId,
      isAdmin,
      gender,
      newAnonClaimToken,
      deps,
    });
  }

  // resolved / unresolved_area → follow-up with the frozen snapshot.

  const snapshot = conversation.signalsSnapshot;
  if (!snapshot) {
    // Post-transition conversation without a snapshot is a data anomaly —
    // observable, not a user error.
    await deps.emit({
      type: "persistence_failure",
      conversationId: conversation.id,
      payload: { reason: "missing_signals_snapshot" },
    });
    return { type: "lake_unresolved", text: LAKE_UNRESOLVED_MESSAGE };
  }

  // Lake switch: a post-transition turn that names a NEW lake (or continues
  // an in-flight switch clarify with a municipality) re-enters resolution.
  // The credit was spent at the first transition — switching is free; the
  // turn caps bound the rounds. Replaces the old lake-lock redirect.
  const switchTarget = getSwitchTarget(conversation, extraction);
  if (switchTarget !== null) {
    return attemptLakeSwitch({
      conversation,
      extraction,
      switchTarget,
      message,
      history,
      gender,
      deps,
    });
  }

  const persistedUserCount =
    messageCount ?? (await deps.countUserMessages(conversation.id));
  const turnIndex = persistedUserCount + 1;

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
    conversationId: conversation.id,
  };
}

// ---------------------------------------------------------------------------
// Resolution step — shared by brand-new and pending-follow-up turns
// ---------------------------------------------------------------------------

async function resolvePendingConversation(ctx: {
  conversation: ConversationRow;
  extraction: Extraction;
  message: string;
  history: HistoryMessage[];
  userId: string | null;
  isAdmin: boolean;
  gender?: string;
  /** Set when THIS request created the conversation (route sets the cookie). */
  newAnonClaimToken: string | null;
  deps: AskHandlerDeps;
}): Promise<AskResult> {
  const {
    conversation,
    extraction,
    message,
    history,
    userId,
    isAdmin,
    gender,
    newAnonClaimToken,
    deps,
  } = ctx;

  const userLoc: UserLocation | undefined =
    conversation.userLat !== null && conversation.userLon !== null
      ? { lat: conversation.userLat, lon: conversation.userLon }
      : undefined;

  // Pivot rule: a clarify round targeting a NEW lake name starts with a fresh
  // strike count — strikes accumulated on "Puttern" must not count against
  // "Hjälmaren". pendingLakeName null means "no target yet", so any named
  // lake is a fresh target (harmless on the first message: attempts are 0).
  const isPivot =
    extraction.lakeName !== undefined &&
    (conversation.pendingLakeName == null ||
      extraction.lakeName.toLowerCase() !==
        conversation.pendingLakeName.toLowerCase());
  const priorAttempts = isPivot ? 0 : conversation.resolveAttempts;

  const claimTokenPart =
    newAnonClaimToken !== null ? { claimToken: newAnonClaimToken } : {};

  // Non-lake short-circuit: the extractor classified the named water as a
  // river, coast stretch or town. The register holds only lakes, so candidate
  // SQL + the Haiku resolver can never resolve it — worse, trigram could
  // false-match a similarly named lake. Skip both and go straight to area
  // mode. The extractor defaults to "sjö" on any doubt, so this never steals
  // a resolvable lake; "annat" still goes through the resolver.
  const namedNonLake =
    extraction.lakeName !== undefined &&
    (extraction.waterKind === "älv" ||
      extraction.waterKind === "kust" ||
      extraction.waterKind === "ort");

  // Ort clarify: the user most likely means a lake NEAR the named ort, so one
  // free round asking which lake beats an instant (credit-charging) area
  // transition. Only when the ort is a NEW target (isPivot) — insisting on
  // the same ort falls through to the unresolved_area transition below.
  if (namedNonLake && extraction.waterKind === "ort" && isPivot) {
    const ortName = extraction.lakeName as string; // namedNonLake implies defined
    await deps.recordClarifyRound(conversation.id, {
      attempts: priorAttempts + 1,
      pendingLakeName: ortName,
    });
    await deps.emit({
      type: "lake_clarify",
      conversationId: conversation.id,
      payload: {
        attempt: priorAttempts + 1,
        confidence: 0,
        lakeName: ortName,
        clarifyQuestion: ortClarifyMessage(ortName),
        reason: "ort",
        prompt: message,
        candidateCount: 0,
        candidates: [],
        hasUserLocation: userLoc !== undefined,
      },
    });
    return {
      type: "clarify",
      text: ortClarifyMessage(ortName),
      conversationId: conversation.id,
      ...claimTokenPart,
    };
  }

  const candidates = namedNonLake
    ? []
    : await deps.candidateLakes(extraction.lakeName ?? "", userLoc);

  const resolution: HaikuResolution = namedNonLake
    ? { lakeId: null, confidence: 0, noSuchLake: true, clarifyQuestion: "" }
    : await deps.resolveLakeWithHaiku({
        message,
        lakeName: extraction.lakeName,
        municipality: extraction.municipality,
        userLoc,
        candidates,
        history,
      });

  // Cost analytics: attribute the resolver call to the conversation.
  if (resolution.usage) {
    await deps.emit({
      type: "llm_usage",
      conversationId: conversation.id,
      payload: llmUsagePayload("resolve", resolution.usage),
    });
  }

  // Resolver-input context attached to every non-resolved outcome below —
  // troubleshooting "why didn't this resolve?" needs what Haiku actually SAW
  // (prompt + candidate list), not just the outcome. Capped at 5 candidates
  // to keep the payload bounded; candidateCount preserves the full size.
  const resolutionContext = {
    prompt: message,
    candidateCount: candidates.length,
    candidates: candidates
      .slice(0, 5)
      .map((c) => (c.name ? `${c.name} (${c.municipality})` : c.id)),
    hasUserLocation: userLoc !== undefined,
  };

  // ── Confident pick → resolved ─────────────────────────────────────────

  const picked =
    resolution.lakeId !== null &&
    resolution.confidence >= RESOLVE_CONFIDENCE_THRESHOLD
      ? (candidates.find((c) => c.id === resolution.lakeId) ?? null)
      : null;

  if (picked) {
    const targetTime = await resolveTargetTime(
      extraction,
      conversation.id,
      deps,
    );

    const lakeWithLabel: Lake & { label: string } = {
      ...picked,
      label: picked.name
        ? formatLabel({
            name: picked.name,
            municipality: picked.municipality,
            county: picked.county,
          })
        : picked.id,
    };

    const signals = await deps.buildSignals({
      lake: lakeWithLabel,
      targetTime,
      now: deps.now,
    });

    const charge = await chargeCredit({ userId, isAdmin, deps });
    if (charge.blocked) return charge.blocked;

    await deps.transitionConversation({
      id: conversation.id,
      status: "resolved",
      lakeId: picked.id,
      targetTime,
      signalsSnapshot: signals,
    });
    // conversationId makes "distinct conversations per lake" queryable (the
    // TopLakeRow doc note); confidence/attempt profile the resolver itself.
    await deps.emit({
      type: "lake_resolved",
      lakeId: picked.id,
      conversationId: conversation.id,
      payload: {
        lakeName: extraction.lakeName ?? null,
        confidence: resolution.confidence,
        attempt: priorAttempts + 1,
      },
    });

    const stream = deps.adviseFirst({ signals, message, history, gender });
    return {
      type: "stream",
      stream,
      conversationId: conversation.id,
      badges: toBadges(signals, "resolved"),
      ...claimTokenPart,
      ...(charge.refundUserId ? { refundUserId: charge.refundUserId } : {}),
    };
  }

  // ── Strikes exhausted or confident no-such-lake → unresolved_area ─────

  const attemptsAfterThis = priorAttempts + 1;
  if (resolution.noSuchLake || attemptsAfterThis >= MAX_RESOLVE_ATTEMPTS) {
    const targetTime = await resolveTargetTime(
      extraction,
      conversation.id,
      deps,
    );

    // Area coords fallback: browser location → candidate centroid → none.
    const coords = userLoc ?? centroidOf(candidates);
    const label = areaLabel(extraction, coords !== undefined);

    // When the user named no lake but shared a location, the candidates ARE
    // the nearest named lakes (candidateLakes nearby mode) — pass them into
    // the snapshot so "vilken sjö nära mig?" gets real suggestions.
    const nearbyLakes =
      !extraction.lakeName && userLoc
        ? candidates.slice(0, 5).flatMap((c) =>
            c.name
              ? [
                  {
                    name: c.name,
                    municipality: c.municipality,
                    distanceKm: c.distanceKm,
                    areaHa: Math.round(c.areaHa),
                  },
                ]
              : [],
          )
        : undefined;

    const signals = coords
      ? await deps.buildAreaSignals({
          label,
          lat: coords.lat,
          lon: coords.lon,
          askedLakeName: extraction.lakeName,
          askedWaterKind: extraction.waterKind,
          nearbyLakes,
          targetTime,
          now: deps.now,
        })
      : minimalAreaSignals(
          label,
          extraction.lakeName,
          extraction.waterKind,
          targetTime,
        );

    const charge = await chargeCredit({ userId, isAdmin, deps });
    if (charge.blocked) return charge.blocked;

    await deps.transitionConversation({
      id: conversation.id,
      status: "unresolved_area",
      lakeId: null,
      targetTime,
      signalsSnapshot: signals,
    });
    // reason separates "the extractor says it's not a lake" from "the
    // resolver is sure it doesn't exist" from "we gave up after N rounds" —
    // very different product problems.
    await deps.emit({
      type: "lake_unresolved_area",
      conversationId: conversation.id,
      payload: {
        askedLakeName: extraction.lakeName ?? null,
        waterKind: extraction.waterKind ?? null,
        reason: namedNonLake
          ? "non_lake_water"
          : resolution.noSuchLake
            ? "no_such_lake"
            : "attempts_exhausted",
        attempts: attemptsAfterThis,
        confidence: resolution.confidence,
        ...resolutionContext,
      },
    });

    const stream = deps.adviseFirst({ signals, message, history, gender });
    return {
      type: "stream",
      stream,
      conversationId: conversation.id,
      badges: toBadges(signals, "unresolved_area"),
      ...claimTokenPart,
      ...(charge.refundUserId ? { refundUserId: charge.refundUserId } : {}),
    };
  }

  // ── Not confident yet → free clarify round ─────────────────────────────

  await deps.recordClarifyRound(conversation.id, {
    attempts: attemptsAfterThis,
    pendingLakeName:
      extraction.lakeName ?? conversation.pendingLakeName ?? null,
  });
  await deps.emit({
    type: "lake_clarify",
    conversationId: conversation.id,
    payload: {
      attempt: attemptsAfterThis,
      confidence: resolution.confidence,
      lakeName: extraction.lakeName ?? null,
      clarifyQuestion: resolution.clarifyQuestion,
      ...resolutionContext,
    },
  });

  return {
    type: "clarify",
    text: resolution.clarifyQuestion,
    conversationId: conversation.id,
    ...claimTokenPart,
  };
}

/**
 * Decides whether a post-transition turn is a lake-switch attempt, and for
 * which name. Returns null for ordinary follow-ups.
 *
 * Explicit: the extractor named a lake-ish water (sjö/annat/no kind) that is
 * not the conversation's current lake — in unresolved_area ANY named lake
 * counts. Continuation: no lake named, but a switch clarify is in flight and
 * the user supplied a municipality ("i Örebro"). A reply with neither keeps
 * the pending target for a later turn and follows up normally.
 */
export function getSwitchTarget(
  conversation: Pick<
    ConversationRow,
    "status" | "bareLakeName" | "pendingLakeName"
  >,
  extraction: Extraction,
): string | null {
  if (extraction.lakeName !== undefined) {
    const lakeish =
      extraction.waterKind === undefined ||
      extraction.waterKind === "sjö" ||
      extraction.waterKind === "annat";
    if (!lakeish) return null;
    if (conversation.status === "unresolved_area") return extraction.lakeName;
    const current = conversation.bareLakeName ?? null;
    // Legacy resolved rows (snapshot without bareLakeName) intentionally treat ANY
    // named lake as a switch — re-resolving the same lake is an acceptable upgrade
    // (fresh snapshot), bounded by turn caps.
    if (
      current !== null &&
      extraction.lakeName.toLowerCase() === current.toLowerCase()
    ) {
      return null;
    }
    return extraction.lakeName;
  }
  if (conversation.pendingLakeName && extraction.municipality) {
    return conversation.pendingLakeName;
  }
  return null;
}

async function attemptLakeSwitch(ctx: {
  conversation: ConversationRow;
  extraction: Extraction;
  switchTarget: string;
  message: string;
  history: HistoryMessage[];
  gender?: string;
  deps: AskHandlerDeps;
}): Promise<AskResult> {
  const {
    conversation,
    extraction,
    switchTarget,
    message,
    history,
    gender,
    deps,
  } = ctx;

  const userLoc: UserLocation | undefined =
    conversation.userLat !== null && conversation.userLon !== null
      ? { lat: conversation.userLat, lon: conversation.userLon }
      : undefined;

  // Pivot rule, same as the pending phase: a new target starts fresh.
  const isPivot =
    conversation.pendingLakeName == null ||
    switchTarget.toLowerCase() !== conversation.pendingLakeName.toLowerCase();
  const priorAttempts = isPivot ? 0 : conversation.resolveAttempts;

  const candidates = await deps.candidateLakes(switchTarget, userLoc);
  const resolution = await deps.resolveLakeWithHaiku({
    message,
    lakeName: switchTarget,
    municipality: extraction.municipality,
    userLoc,
    candidates,
    history,
  });

  if (resolution.usage) {
    await deps.emit({
      type: "llm_usage",
      conversationId: conversation.id,
      payload: llmUsagePayload("resolve", resolution.usage),
    });
  }

  // Same troubleshooting context as the pending phase: what Haiku SAW.
  const resolutionContext = {
    prompt: message,
    candidateCount: candidates.length,
    candidates: candidates
      .slice(0, 5)
      .map((c) => (c.name ? `${c.name} (${c.municipality})` : c.id)),
    hasUserLocation: userLoc !== undefined,
  };

  const picked =
    resolution.lakeId !== null &&
    resolution.confidence >= RESOLVE_CONFIDENCE_THRESHOLD
      ? (candidates.find((c) => c.id === resolution.lakeId) ?? null)
      : null;

  if (picked) {
    const targetTime = await resolveTargetTime(
      extraction,
      conversation.id,
      deps,
    );
    const lakeWithLabel: Lake & { label: string } = {
      ...picked,
      label: picked.name
        ? formatLabel({
            name: picked.name,
            municipality: picked.municipality,
            county: picked.county,
          })
        : picked.id,
    };
    const signals = await deps.buildSignals({
      lake: lakeWithLabel,
      targetTime,
      now: deps.now,
    });

    // NO credit charge here — spent once at the first lake_pending exit.
    // transitionConversation resets resolveAttempts + pendingLakeName.
    await deps.transitionConversation({
      id: conversation.id,
      status: "resolved",
      lakeId: picked.id,
      targetTime,
      signalsSnapshot: signals,
      ...(extraction.title ? { title: extraction.title } : {}),
    });
    await deps.emit({
      type: "lake_switched",
      lakeId: picked.id,
      conversationId: conversation.id,
      payload: {
        fromLakeId: conversation.lakeId ?? null,
        fromStatus: conversation.status,
        lakeName: switchTarget,
        confidence: resolution.confidence,
        attempt: priorAttempts + 1,
      },
    });

    const stream = deps.adviseFirst({ signals, message, history, gender });
    return {
      type: "stream",
      stream,
      conversationId: conversation.id,
      badges: toBadges(signals, "resolved"),
    };
  }

  const attemptsAfterThis = priorAttempts + 1;
  if (resolution.noSuchLake || attemptsAfterThis >= MAX_RESOLVE_ATTEMPTS) {
    // Give up on the switch, keep the current context. The target stays
    // recorded with attempts pinned at max so a re-mention of the same name
    // goes straight back here (a confident resolution still wins above);
    // a DIFFERENT name is a pivot and starts fresh.
    await deps.recordClarifyRound(conversation.id, {
      attempts: MAX_RESOLVE_ATTEMPTS,
      pendingLakeName: switchTarget,
    });
    await deps.emit({
      type: "lake_switch_failed",
      conversationId: conversation.id,
      payload: {
        lakeName: switchTarget,
        reason: resolution.noSuchLake ? "no_such_lake" : "attempts_exhausted",
        confidence: resolution.confidence,
        ...resolutionContext,
      },
    });
    const currentContext =
      conversation.bareLakeName ??
      conversation.signalsSnapshot?.lake ??
      "det vi pratade om";
    return {
      type: "clarify",
      text: switchGiveUpMessage(currentContext),
      conversationId: conversation.id,
    };
  }

  await deps.recordClarifyRound(conversation.id, {
    attempts: attemptsAfterThis,
    pendingLakeName: switchTarget,
  });
  await deps.emit({
    type: "lake_clarify",
    conversationId: conversation.id,
    payload: {
      attempt: attemptsAfterThis,
      confidence: resolution.confidence,
      lakeName: switchTarget,
      clarifyQuestion: resolution.clarifyQuestion,
      phase: "switch",
      ...resolutionContext,
    },
  });
  return {
    type: "clarify",
    text: resolution.clarifyQuestion || LAKE_CLARIFY_FALLBACK,
    conversationId: conversation.id,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spend the credit at the transition out of lake_pending (ADR-0004 adapted:
 * Credit = a decided context + a Sonnet first answer). Skipped for anon (their
 * quota is the one-conversation claim gate) and admins.
 */
async function chargeCredit(ctx: {
  userId: string | null;
  isAdmin: boolean;
  deps: AskHandlerDeps;
}): Promise<{ blocked?: AskResult; refundUserId?: string }> {
  const { userId, isAdmin, deps } = ctx;
  if (!userId || isAdmin) return {};
  const spent = await deps.spendCredit(userId);
  if (!spent) {
    // reason: "spend_race" = the guarded UPDATE lost the race past the free
    // limit (E5), as opposed to the cheap "pre_check" gate in handleAsk.
    await deps.emit({
      type: "out_of_credits",
      payload: { userId, reason: "spend_race" },
    });
    return {
      blocked: { type: "out_of_credits", text: OUT_OF_CREDITS_MESSAGE },
    };
  }
  return { refundUserId: userId };
}

/** Swedish relative time → Date, with ISO tolerance and `now` fallback. */
async function resolveTargetTime(
  extraction: Extraction,
  conversationId: string,
  deps: AskHandlerDeps,
): Promise<Date> {
  const resolvedTime = resolveSwedishTime(extraction.time, deps.now);
  const isoTime = extraction.time ? new Date(extraction.time) : null;
  const isoParsed = isoTime !== null && !Number.isNaN(isoTime.getTime());
  if (extraction.time && resolvedTime === null && !isoParsed) {
    await deps.emit({
      type: "time_parse_fallback",
      conversationId,
      payload: { time: extraction.time },
    });
  }
  return resolvedTime ?? (isoParsed ? (isoTime as Date) : deps.now);
}

/** Average position of the candidate list, or undefined when empty. */
export function centroidOf(
  candidates: CandidateLake[],
): UserLocation | undefined {
  if (candidates.length === 0) return undefined;
  const lat = candidates.reduce((sum, c) => sum + c.lat, 0) / candidates.length;
  const lon = candidates.reduce((sum, c) => sum + c.lon, 0) / candidates.length;
  return { lat, lon };
}

/** Swedish area label for unresolved-area snapshots. */
export function areaLabel(extraction: Extraction, hasCoords: boolean): string {
  if (extraction.municipality)
    return `trakten kring ${extraction.municipality}`;
  if (hasCoords) return "trakten där du är";
  return "okänt vatten";
}

/** Honest minimum when no coordinates exist at all: time + area flags only. */
function minimalAreaSignals(
  label: string,
  askedLakeName: string | undefined,
  askedWaterKind: Signals["askedWaterKind"],
  targetTime: Date,
): Signals {
  return {
    lake: label,
    lakeId: "area",
    areaOnly: true,
    ...(askedLakeName ? { askedLakeName } : {}),
    ...(askedWaterKind ? { askedWaterKind } : {}),
    timeLocal: formatStockholmLocal(targetTime),
  };
}
