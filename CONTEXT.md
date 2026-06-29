# Fråga Fiskargubben

A fishing-advice **chatbot**: the user types a free-text question naming a Swedish lake and a
time, the system gathers open environmental data, distills it into fishing-relevant **Signals**,
and an LLM turns those signals into concrete fishing advice in a consistent persona
("Fiskargubben", the old fisherman). The conversation continues with cheap follow-up turns over
the same data.

## Language

**Lake**:
A Swedish lake the user can ask about. Resolved from the national lake register (SVAR) — the
**single source of truth**; all ~100k water bodies are pre-imported, so there is no runtime
geocoding fallback. A lake that won't resolve gets an in-persona reprompt ("kände inte igen den
sjön — stava annorlunda?"), not a second geocoder. Carries an official **Lake id**, centroid
coordinates, and a municipality label for disambiguation.
_Avoid_: pond, water (when meaning a specific named lake).

**Lake id**:
The official SVAR identifier for a **Lake**. The join key used to look up water chemistry and
species in the SLU datasets.
_Avoid_: "lake code" in prose.

**Signals**:
The compact, code-computed object of fishing-relevant conclusions (pressure trend, light
window, windward shore, water temp, species comfort, …) that is fed to the LLM. The LLM
reasons over Signals; it never parses raw API payloads.
_Avoid_: "the data", "conditions object", "payload".

**Lake label**:
The disambiguation string shown in typeahead and echoed back to the user: `name (municipality,
county)`. Mandatory because many lakes share a name. Unnamed water bodies are imported (for
joins) but hidden from search.
_Avoid_: "display name", "title".

**Target time**:
The local time the user intends to fish, against which the forecast entry and the light window
are computed.
_Avoid_: "fishing time" in code identifiers (use targetTime).

**Advice**:
The natural-language fishing recommendation the LLM returns, in the Fiskargubben persona,
written in **Swedish**. Streamed to the client.
_Avoid_: "answer" in prose (though the API field is `answer`), "response".

**Fiskargubben** (the persona):
The voice the **Advice** is delivered in: a weathered, gruff, concrete old Swedish fisherman who
**only talks fishing** and refuses off-topic questions in character. Lives as a frozen
system-prompt constant (cached across calls), shared by both advice models — the **first prompt**
of a conversation is answered by Claude Sonnet 4.6, **follow-up** turns by Claude Haiku 4.5.
**Gender:** addresses the user with a gendered term only if the SSO provider (Google/Microsoft)
supplied a gender at sign-in; otherwise — and for anonymous users — stays **neutral** ("hörru", "du
där", "kompis"). In practice the IdPs rarely return gender, so neutral is the common case. Never
asks for or stores a gender form field.
_Avoid_: "the bot", "assistant", "AI"; assuming the user's gender.

**Conversation** (also "chat"):
A multi-turn chat between a user and Fiskargubben. The unit of billing: its **first prompt**
triggers one fresh data fetch and Sonnet **Advice**, costing one **Credit**; all later turns are
free Haiku replies over the conversation's frozen **Signals** snapshot. Persisted in Postgres for
logged-in users; for anonymous users it is a real DB row with `userId` null, capped at one prompt,
claimable on registration.
_Avoid_: "thread", "session" (session means the auth session).

**Signals snapshot**:
The **Signals** captured **once**, when a **Conversation**'s first prompt resolves its **Context**.
Frozen for the life of the conversation — reopening an old chat days later answers from the same
snapshot (free Haiku) with a "starta ny chatt för färsk data" nudge; it is never silently
re-fetched. A new conversation = a fresh snapshot = one **Credit**.
_Avoid_: "cache" (the snapshot is not invalidated by the 1h forecast cache).

**Context** (conversation context):
The resolved `(Lake, Target time)` pair a conversation is about, **locked** at its first prompt —
one lake per conversation, immutable. If a **follow-up** names a different lake (or clearly
different time), the conversation does **not** re-fetch or escalate; Haiku declines in persona
("jag känner bara till {lake}, grabben — dra igång en ny chatt för ett annat vatten") with no
answer and no **Credit** spent. A different lake means a new conversation.
_Avoid_: "topic", "scope".

**Credit**:
The unit of the free quota: one **Credit** = one fresh data fetch + one Sonnet first-prompt = one
new **Conversation**. Free tier = **3 Credits, lifetime** (not per day). Follow-up Haiku turns and
in-persona off-topic refusals cost nothing. A paid tier (~49 SEK/year) lifts the cap — stubbed for
now behind an `isPaid` flag the quota gate reads; real payment is a future phase. **Carry-over:**
an anonymous user's single prompt is a spent Credit; when they register and **Claim** that
conversation, the spend transfers — the new account starts with 1 of 3 used (2 left), not a fresh 3.
_Avoid_: "token", "prompt" (a follow-up is a prompt but not a Credit).

**Chat turn limit**:
A hard ceiling (~20 turns) on follow-up messages within a single **Conversation**, separate from
the **Credit** quota — Credits cap fresh fetches across chats; this caps Haiku follow-ups inside one
chat. On hit there is **no answer and no persona**: a plain system alert ("Starta en ny chatt")
replaces the reply and the chat is frozen to further input. A real angler never reaches it; it stops
loops and abuse.
_Avoid_: "rate limit" (it's per-conversation, not per-time).

**Wind-down**:
A soft taper before the hard **Chat turn limit**. A `windingDown` flag flips at turn **15** and is
passed into the Haiku **follow-up** call; the persona then keeps replies short and starts signing
off in character ("nu har vi vänt på det mesta, lycka till där ute"). Turns 1–15 reply normally,
16–20 wind down, turn ~20 hits the hard freeze. In persona (unlike the chat-limit alert), because
Gubben is choosing to round off, not the system blocking him.
_Avoid_: "timeout", "cooldown".

**Analytics event**:
A row in the append-only `analytics_events` table (type, lake_id?, payload jsonb, ts) emitted inline
from the pipeline. The event taxonomy is defined up front so emit-sites exist everywhere from day
one: e.g. `lake_resolved`, `lake_unresolved`, `source_miss` (which of forecast/metobs/S-HYPE/SLU
returned nothing), `credit_spent`, `topic_refused`, `chat_limit_hit`, `signals_built`. Dashboards
and any external analytics are a deferred phase; the raw events are captured now.
_Avoid_: "log", "metric" (these are structured domain events, not app logs).

**Extractor**:
A cheap Claude Haiku structured call that turns a user's free-text message into
`{onTopic, lakeName, municipality?, time, intent}` and detects whether the **Context** changed.
Doubles as the **topic gate**: `onTopic = false` → an in-persona Haiku refusal, with no Sonnet
call and no **Credit** spent. Runs before any advice call.
_Avoid_: "parser", "router".

**Light window**:
A derived Signal categorising the **Target time** relative to computed sunrise/sunset at the
lake's coordinates: `dawn` | `day` | `dusk` | `night`, where dawn/dusk are the ~±45 min prime
windows around sunrise/sunset. Sun times are computed in code (solar formula), not fetched.
_Avoid_: "time of day", "daylight".

**Windward shore**:
The downwind shore the wind blows *toward* — where baitfish and active fish stack, and the shore
an angler targets. Derived as `wind_from_direction + 180°` (SMHI `wind_from_direction` is the
meteorological "blows FROM" bearing). NOT the upwind shore the wind comes from.
_Avoid_: "wind direction" (that's the raw input), "upwind shore".

**Species comfort**:
Derived flags (e.g. `pike_sluggish` when water > ~21 °C) produced from a small per-species code
rules table over water temp and season. Conclusions, not raw numbers, reach the LLM.
_Avoid_: "fish mood", "activity" (too vague).

**Provenance**:
Per-Signal metadata describing where a value came from and how much to trust it: `source`
(`forecast` | `observed` | `modeled` | `estimated`) and a confidence flag. E.g. air-temp from a
station >40 km away, or water temp estimated rather than modeled, is marked low-confidence so the
LLM hedges its **Advice**. Missing values degrade gracefully (the Signal is simply absent).
_Avoid_: "metadata", "quality" — be specific: source + confidence.

**Claim** (anon conversation claim):
The act of attaching an anonymous **Conversation** to a newly registered user, by matching a
`claimToken` held in a signed cookie. Unclaimed anon conversations are garbage-collected after a TTL.
_Avoid_: "transfer", "migrate", "merge".

## Flagged ambiguities

- **"Session"** is overloaded: the Better Auth login session vs. a chat. We call the chat a
  **Conversation** and reserve "session" for auth.
- **Anonymous conversations are persisted**, not ephemeral — a DB row is required so it can be
  **Claimed** on registration. "Ephemeral for anon" only means: not resumable, one prompt, GC'd if unclaimed.
