import { logError } from "@/lib/log/logger";
import { db as realDb } from "@/shared/db/client";
import { analyticsEvents } from "@/shared/db/schema";

export type AnalyticsEventType =
  | "lake_resolved"
  | "lake_unresolved"
  // Several real lakes share the named body — we asked which municipality
  // instead of guessing. Distinct from lake_unresolved (no match at all) so the
  // "ambiguous name" reprompt rate is queryable on its own.
  | "lake_ambiguous"
  | "source_miss"
  | "signals_built"
  | "credit_spent"
  // C-refund: the first-turn Sonnet stream failed after the credit was spent,
  // so the credit was returned. Pairs with credit_spent to reconcile spend.
  | "credit_refunded"
  // payload { prompt, userId? } — the refused message is captured here because
  // the refusal path never persists a message row (route-capped length, so the
  // payload stays bounded). conversationId set on follow-up-turn refusals.
  | "topic_refused"
  | "chat_limit_hit"
  // M6: emitted on every attempt against an ALREADY-frozen conversation, kept
  // distinct from chat_limit_hit (the one-time transition emitted by
  // freezeConversation) so a dashboard counting chat_limit_hit measures chats
  // that hit the limit, not retries against frozen chats.
  | "chat_limit_retry"
  // H7: previously-invisible gate paths — the anon→register funnel,
  // lake-lock redirects, and credit exhaustion all emit now.
  // register_gate payload { reason: anon_claim_used | anon_ip_limit };
  // lake_lock payload { lockKey, attemptedLake };
  // out_of_credits payload { userId, reason: pre_check | spend_race }.
  | "register_gate"
  | "lake_lock"
  | "out_of_credits"
  // H4: surfaced when post-stream assistant-turn persistence fails so the
  // dropped turn is observable instead of being swallowed by catch {}.
  | "persistence_failure"
  // L-rt1: an exception escaping handleAsk in the POST handler — makes
  // "where did the pipeline fail" queryable instead of an invisible 5xx.
  | "pipeline_error"
  // L-ah1: the Extractor returned a relative Swedish time (e.g. "ikväll") that
  // new Date() can't parse, so Signals fell back to `now`. Emitted so the
  // prevalence of this silent degradation is visible.
  | "time_parse_fallback"
  // Rebuild: the Haiku resolver was not confident enough (< threshold) and we
  // asked the user to be more specific — a free clarify round.
  | "lake_clarify"
  // Rebuild: resolution gave up (attempts exhausted or confident no-such-lake);
  // the conversation continues in area mode on SMHI signals only.
  | "lake_unresolved_area"
  // Lake switch (spec 2026-07-08): a post-transition turn re-resolved to a
  // new lake. payload { fromLakeId, fromStatus, lakeName, confidence, attempt }.
  | "lake_switched"
  // A switch attempt gave up (attempts exhausted or confident no-such-lake);
  // the conversation keeps its previous context. payload { lakeName, reason,
  // confidence } + resolver context (prompt, candidates).
  | "lake_switch_failed"
  // Rebuild: a registration was rejected by the signup IP guard.
  | "signup_ip_blocked"
  // Paid fair-use cap hit (PAID_FAIR_USE_CONVERSATION_LIMIT) — payload
  // { userId, recent } so repeat offenders are queryable.
  | "fair_use_limit"
  // The chat terms gate was accepted (stored on the account when logged in).
  | "tos_accepted"
  // One Anthropic API call's token usage + USD cost (see lib/analytics/llm-cost.ts).
  // payload { kind, model, inputTokens, outputTokens, cacheCreationInputTokens,
  // cacheReadInputTokens, costUsd } — conversationId set when known, so cost
  // rolls up per conversation and (via conversations.user_id) per account.
  | "llm_usage"
  // Feedback prompt funnel (spec 2026-07-06-feedback-prompt-design.md). All
  // payloads { userId, chatCount }; submitted adds { message } — the feedback
  // text lives HERE (no dedicated table). dismissed = closed with no prior
  // discord click or submit.
  | "feedback_prompt_shown"
  | "feedback_prompt_dismissed"
  | "feedback_prompt_discord_clicked"
  | "feedback_prompt_submitted";

export interface AnalyticsEvent {
  type: AnalyticsEventType;
  lakeId?: string;
  conversationId?: string;
  /**
   * L10 / M10(b): free-form payload — permits emit-site drift. A discriminated
   * union keyed on `type` with a required payload shape per variant would be
   * tighter, but it is a mechanical refactor across every emit site (~30 sites)
   * with no behavioural change. [~] deferred: discriminated payload union (wide
   * ripple). The most drift-prone payloads are kept consistent by convention:
   * source_miss → { source, reason }; credit_spent → { userId };
   * persistence_failure → { reason }; pipeline_error → { reason, prompt }.
   */
  payload?: Record<string, unknown>;
}

export interface EmitDeps {
  db: Pick<typeof realDb, "insert">;
}

export async function emit(
  event: AnalyticsEvent,
  deps: EmitDeps = { db: realDb },
): Promise<void> {
  try {
    await deps.db.insert(analyticsEvents).values({
      type: event.type,
      lakeId: event.lakeId ?? null,
      conversationId: event.conversationId ?? null,
      payload: event.payload ?? {},
    });
  } catch (err) {
    // M10(a): analytics writes are non-fatal, but the insert failing is the one
    // case where observability goes dark — so log a STRUCTURED single line at
    // error level with a stable prefix a log-based alert can match on, instead
    // of a free-text console.warn. (A discriminated payload union — M10(b) — is
    // deferred: see AnalyticsEvent.payload.)
    logError("analytics.emit", err, { eventType: event.type });
  }
}
