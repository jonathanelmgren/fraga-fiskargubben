# Task 6.1 Report — Chat UI

## Design direction

**Palette/font**: Reuses the existing design-token palette (warm amber/teal/stone from globals.css). No new fonts added — the existing Geist carries body text fine. A subtle `radial-gradient` water-ripple wash is applied to the `.ask-page` background (oklch blue-teal at low opacity), evoking a still morning lake surface without being gimmicky.

**Gubbe mascot**: Used in three places — (1) the empty-state centre of the chat, 96×96 rounded-full with an amber border and shadow, (2) the assistant message bubble avatar 40×40 at top-left of every Fiskargubben response, (3) faded (opacity-70) for the "tänker…" thinking indicator. The page header links back to home with the `gubbe-icon.png` small variant.

**Motif**: A "casting-dot" animation (three bouncing dots) is used for the thinking state, the streaming button state, and the streaming cursor — suggesting a fishing line being cast. The submit button is labelled "Kasta" (cast) instead of generic "Send". The placeholder is "Fråga Fiskargubben…". Swedish copy throughout.

**Message bubbles**: User messages are right-aligned teal/primary bubbles with a lower-right corner radius (`1rem 1rem 0.25rem 1rem`). Fiskargubben messages are left-aligned card-background bubbles with `0.25rem 1rem 1rem 1rem` — classic chat tail geometry, visually clear whose is whose.

## Streaming approach

`fetch('/api/ask', { method: 'POST', ... })` — on a `text/plain` Content-Type response, reads `response.body.getReader()` + `TextDecoder` in a `while (!done)` loop appending each chunk to the last assistant message via `setMessages`. The `X-Conversation-Id` header is captured after the first response and sent on all subsequent requests. A stable `id` (module-level counter, `msg-${n}`) is given to each message so React keys are stable.

## Gate response rendering — plain vs persona

| Gate type | Rendering |
|---|---|
| `chat_limit` | `<section aria-label="Chatbegränsning" class="chat-limit-banner">` — plain anchor-icon + grey system notice. NOT a chat bubble. Frozen state also disables input and textarea placeholder changes. |
| `topic_refused`, `lake_unresolved`, `lake_lock` | `AssistantBubble` — identical to normal Fiskargubben messages, with gubbe avatar. It's him talking. |
| `register_to_continue` | `<div class="gate-cta">` amber-warm CTA card with "Skapa konto" + "Logga in" links. |
| `out_of_credits` | `<div class="gate-credits">` neutral stone card with friendly text — no payment link (stubbed). |

Persona gates are fed directly into `messages` as `{ role: "assistant" }` (not a separate `gate` type) so they naturally slot into the conversation flow.

## Credits / anon handling

The user's name is shown in the page header (server component). The client chat component does not call `useSession` — `creditsUsed` is not in the session payload client-side, so remaining credits were deferred as instructed. The register CTA shows the same links regardless of auth state.

## Component test coverage

`src/app/ask/chat.test.tsx` — 5 tests:
1. Form submission calls `fetch('/api/ask')` with the typed message.
2. `chat_limit` JSON gate renders a plain `<section aria-label="Chatbegränsning">` NOT inside `.chat-bubble-assistant`.
3. `topic_refused` JSON gate renders inside `.chat-bubble-assistant` (persona bubble).
4. Streamed `text/plain` response populates an assistant bubble (lightweight ReadableStream mock).
5. `register_to_continue` gate renders the `.gate-cta` card with `/register` and `/login` links.

Streaming end-to-end (live token arrival, conversationId continuity, frozen state after real chat_limit) is deferred to Phase 6.2 Playwright e2e.

`@testing-library/jest-dom` is not installed; tests use plain `.not.toBeNull()`, `.toContain()`, `.closest()` assertions. The mock for `next/image` uses a `<span>` stub (not `<img>`) to avoid the biome `noImgElement` rule.

## ts:check + biome

- `pnpm ts:check` — passes clean. A `src/image.d.ts` was added (`/// <reference types="next/image-types/global" />`) to provide TypeScript declarations for `*.png` imports, which were absent from the project.
- `pnpm biome` — 0 errors in my files. 3 warnings remain in pre-existing files (`events.test.ts` noExplicitAny, `temp.test.ts` ×2 noGlobalIsFinite) — not my files, not touched.

## Files changed

- `src/app/ask/page.tsx` — server component shell (header with gubbe-icon + session name, renders `<Chat />`).
- `src/app/ask/chat.tsx` — client chat component.
- `src/app/ask/chat.test.tsx` — focused component tests.
- `src/app/page.tsx` — added "Fråga Fiskargubben" CTA link to `/ask`.
- `src/app/globals.css` — added casting-dot animation, `.chat-bubble-user`, `.chat-bubble-assistant`, `.ask-page` water gradient.
- `src/image.d.ts` — PNG import type declarations.

## Self-review

The plain-vs-persona gate distinction is clear both visually and in the DOM structure — `chat_limit` is a `<section>` banner with no avatar, persona gates use `AssistantBubble` with the gubbe image. The streaming pattern is correct: reads body as a ReadableStream, chunks accumulated in the last assistant message. ConversationId is tracked from the first `X-Conversation-Id` header and threaded through subsequent requests. Frozen state disables input + shows the new-chat banner.

## Concerns

1. The `useEffect` scroll trick uses a module-level ref counter (`contentVersion`) to trigger re-runs — this is a workaround for the biome `useExhaustiveDependencies` rule. A cleaner pattern would be to pass `messages.length + thinking` as a state-derived value, but biome flags them as "more deps than necessary" since the effect body doesn't use them. The biome-ignore comment is in place.
2. `msgSeq` is a module-level counter — does not reset between hot-reloads in dev, which is fine. Keys just need to be stable and unique within a session.
3. Streaming is covered lightly in jsdom (single-chunk ReadableStream). Multi-chunk interleaving and error-recovery mid-stream are left for the Playwright e2e in 6.2.
