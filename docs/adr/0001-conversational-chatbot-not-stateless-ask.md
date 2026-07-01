# Conversational chatbot, not a stateless ask endpoint

The original data spec described a stateless `POST /api/ask { lakeId, time }` with a lake
typeahead. We instead build a **conversational AI chatbot**: the user types free text
("i wanna fish in tolken ulricehamn today at 19", "in åsunden, no bites, help"), and a cheap
Claude Haiku **Extractor** resolves lake + time + intent before the data pipeline runs.
Follow-up turns are supported, so **Signals are fetched once per `(lake, target-time)` context**
and cached on the **Conversation**, re-fetched only when the user names a new lake or time.

**Persistence:** Conversations are Postgres rows. Logged-in users get persisted, resumable
history. An anonymous user gets one free prompt in a real DB row with `userId` null and a
`claimToken` in a signed cookie; registering **Claims** that conversation (sets `userId`).
Unclaimed anon rows are GC'd after a TTL. The anon quota is enforced server-side, before any
Claude call. The claimed conversation is a **spent Credit**: after the claim the new account has
1 of its 3 Credits used (see ADR-0004), so registering does not reset the anon prompt to free.

**Why over the stateless form:** the product is a chatbot — natural-language input and
multi-turn follow-ups ("what depth?", "which lure colour?") are the core UX, and reusing the
same conditions to also reason over recent-past weather trend ("cold last few days, water's
likely cold") only makes sense with a retained context. The cost is a real schema (conversations,
messages, cached Signals) and an anon→register claim flow, accepted deliberately.
