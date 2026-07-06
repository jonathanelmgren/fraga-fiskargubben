# Feedback Prompt Dialog — Design

**Date:** 2026-07-06
**Status:** Approved

## Purpose

Prompt engaged users (logged in, ≥3 chats) for feedback via a dialog that promotes
the Discord community first and offers an inline quick-feedback form second. Track
the full funnel (shown / dismissed / Discord click / form submit) in server-side
analytics so conversion per channel is measurable.

## Eligibility

Logged-in users only. Two new columns on `user`:

| Column | Type | Meaning |
|---|---|---|
| `feedback_prompted_at` | timestamp, nullable | When the prompt was last shown |
| `feedback_prompted_chat_count` | integer, default 0 | User's conversation count at that moment |

Eligible when either:

- `chatCount >= 3` and `feedback_prompted_at IS NULL` (first prompt, 3rd chat), or
- `chatCount >= feedback_prompted_chat_count + 5` **and** `feedback_prompted_at`
  is more than 30 days ago (so: 3rd chat, then 8th, 13th, … each gated by a
  30-day minimum gap).

`chatCount` = `count(*)` from `conversations where user_id = ?` (frozen included —
a frozen chat was still a real chat).

Rejected alternative: deriving last-prompt state from `analytics_event` payload
jsonb — unindexed per-request jsonb query, fragile against payload drift.

## Flow

1. `/ask` server component computes eligibility and passes a boolean prop to a
   new client component `FeedbackPromptDialog`.
2. On mount (when eligible) the dialog renders and POSTs
   `/api/feedback-prompt {action: "shown"}`. The server stamps
   `feedback_prompted_at = now()` and `feedback_prompted_chat_count = chatCount`,
   then emits `feedback_prompt_shown`. Stamping at show-time (not page-serve time)
   keeps stats honest and prevents repeat shows across tabs.
3. Dialog contents (portal + backdrop pattern from `support-dialog.tsx`, Swedish
   copy, no i18n library):
   - Text promoting the Discord community + link button using
     `NEXT_PUBLIC_DISCORD_INVITE` (dialog section hidden if env unset).
   - Divider, then a textarea + submit button for users who just want to leave a
     quick note.
4. User actions, all POSTs to the same route:
   - **Discord click** → `{action: "discord_clicked"}`, fire-and-forget
     (`keepalive: true`); link opens in new tab regardless.
   - **Form submit** → `{action: "submitted", message}` → emits
     `feedback_prompt_submitted` with the message in the payload **and** sends
     `notifyDiscord("signups", …)` with the feedback text (same webhook as
     signups, per product decision). Dialog swaps to a brief thanks-state, then
     closes.
   - **Close / Escape / backdrop** with no prior action →
     `{action: "dismissed"}` → `feedback_prompt_dismissed`.

## API route

`POST /api/feedback-prompt` following the `/api/preferences` conventions:
same-origin check via `isSameOriginRequest`, session required (401 otherwise),
zod-style validation of `action` ∈ {shown, dismissed, discord_clicked, submitted}
and `message` (required for `submitted`, max ~2000 chars, trimmed, non-empty).
Responds `Response.json({ ok: true })`.

Only `shown` mutates the user row. Other actions just emit events (and Discord
notify for `submitted`).

## Analytics

New `AnalyticsEventType` members in `src/lib/analytics/events.ts`:

- `feedback_prompt_shown`
- `feedback_prompt_dismissed`
- `feedback_prompt_discord_clicked`
- `feedback_prompt_submitted`

All payloads include `{ userId, chatCount }`; `submitted` adds `{ message }`.
No Plausible tracking (server events only, per product decision). No new
feedback table — message lives in the event payload.

New query in `src/lib/analytics/queries.ts`: `feedbackPromptFunnel()` returning
counts per event type so show→submit conversion per channel is one query.

## Error handling

- Analytics `emit` is already non-fatal (logs, never throws) — unchanged.
- `notifyDiscord` is fire-and-forget with timeout — a Discord outage never fails
  the submit; the event row is the source of truth.
- Client POST failures: ignored for shown/dismissed/discord_clicked (stats-only);
  for submit, show inline error and keep the textarea content.

## Testing

- Unit tests for the eligibility function: chat counts 2/3 (boundary), 7/8 after
  first prompt, 8th chat at 29 vs 31 days, never-prompted vs prompted.
- Route tests: each action emits the right event; `shown` stamps the user row;
  `submitted` requires non-empty message; unauthenticated → 401.
