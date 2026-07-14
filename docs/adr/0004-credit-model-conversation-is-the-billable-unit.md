# The conversation is the billable unit; Signals are frozen per conversation

A **Credit** buys one fresh data fetch + one Sonnet first-prompt = one new **Conversation**. The
free tier is **3 Credits, lifetime** (not per day); a paid tier (~49 SEK/year) lifts the cap and is
**stubbed for now** — the quota gate reads an `isPaid` boolean, and real payment (Swish/Stripe,
webhooks, subscription state, Swedish VAT) is a deliberately deferred future phase. What does *not*
cost a Credit: follow-up Haiku turns within a conversation, and in-persona off-topic refusals
(caught at the Extractor before any Sonnet call).

The mechanism that makes this cheap and predictable: each conversation captures a **Signals
snapshot** once, at its first prompt, and **freezes** it — together with the lake/time **Context**,
which is **locked** to that conversation (one lake per chat). Reopening an old chat days later
answers from that same snapshot — free Haiku, with a "starta ny chatt för färsk data" nudge — and
is never silently re-fetched. Asking about a *different* lake in an existing chat is declined in
persona, not escalated. To get fresh data, or to ask about another water, the user starts a **new**
conversation, which costs a Credit.

**Quota and cost enforcement** is server-side (never client state): the Credit counter decrements
only on a Sonnet first-prompt, gated before the call. Anonymous users get effectively one Credit
(the single claimable prompt of ADR-0001), and that spend **carries over on registration** — a
claimed conversation leaves the new account at 1 of 3 Credits used, not a fresh 3.

**A second, independent gate caps turns within a single conversation** (~20 follow-ups). Credits
bound *fresh fetches across chats*; the chat-turn limit bounds *Haiku follow-ups inside one chat*
so a single free conversation can't become an unbounded Haiku stream. On hit the reply is replaced
by a **plain, non-persona** system alert ("Starta en ny chatt") and the chat is frozen — a system
boundary, deliberately not voiced as Fiskargubben, unlike the in-persona lake-lock and topic-gate
refusals.

**Before that hard wall, a soft wind-down** keeps the ending in character. A `windingDown` flag
flips at turn 15 and is passed into the Haiku follow-up call; the persona then keeps replies short
and starts signing off ("nu har vi vänt på det mesta, lycka till där ute"). So a long chat tapers
in Gubben's own voice over turns 16–20 and only *then* hits the plain freeze at ~20 — the persona
rounds off on its own before the system ever has to block.

**Why frozen-per-conversation rather than always-fresh:** it makes the cost model legible to both
the system and the user — one chat, one fetch, one Credit — and turns "reopening yesterday's chat
is free" into a feature rather than a surprise charge. The cost is that an old chat can serve stale
conditions; that is made honest by the freshness nudge and the topic gate, and is cheaper and less
surprising than auto-refetching (which would spend a Credit on what felt like a free follow-up).

**Why a hard topic lock (fishing only):** the persona refuses non-fishing questions in character,
enforced first at the Haiku Extractor so off-topic probing can never burn a Credit or reach Sonnet.
This bounds both cost and scope creep, and keeps the product's voice intact.

## Amendment (2026-07-08)

The lake-lock ("one conversation = one lake") is retired by the lake-switch
design (`docs/superpowers/specs/2026-07-08-lake-switch-design.md`). The
conversation remains the billable unit: the credit is still spent exactly once,
at the first transition out of `lake_pending`. Later turns that name a new lake
re-enter resolution for free; cost stays bounded by the chat-turn caps
(wind-down at 15, freeze at ~20).
