# Model split: Haiku extracts + gates + follows up, Sonnet writes the first answer

Claude is used at three points, on two model tiers:

1. **Extractor + topic gate** — `claude-haiku-4-5`, structured output, runs first on every turn.
   Returns `{onTopic, lakeName, municipality?, time, intent}` and whether the **Context** changed.
   If `onTopic = false`, it emits an in-persona refusal itself — **no Sonnet call, no Credit spent**.
2. **First-prompt advice** — `claude-sonnet-4-6`. Runs once per conversation, on the first
   on-topic prompt, over the freshly-fetched **Signals**. Streamed, Swedish, in the **Fiskargubben**
   voice. This is the one call worth Sonnet's cost — the rich opening answer — and it spends one
   **Credit**.
3. **Follow-up advice** — `claude-haiku-4-5`. Every later turn in the same conversation. One Haiku
   call both extracts and replies, reusing the conversation's frozen **Signals snapshot**. Free.
   The **Context is locked** to the conversation's lake: if the user names a *different* lake (or a
   clearly different time), Haiku does **not** escalate or re-fetch — it declines in persona ("jag
   känner bara till {lake}, grabben — dra igång en ny chatt för ett annat vatten"). A different lake
   is a new conversation, not a turn in this one.

**Caching:** the **Fiskargubben** system prompt carries `cache_control: ephemeral`. Prompt caching
is a prefix match, so the persona prompt stays byte-frozen — the volatile parts (Signals, the
user's message, history, the `windingDown` flag, any IdP-supplied gender) go *after* the cached
prefix, never interpolated into it.

**Per-turn flags fed to the follow-up call:** `windingDown` (flips at turn 15 → persona shortens and
signs off; see ADR-0004) and the user's gender **only if the SSO provider supplied one** at sign-in
(else neutral address — the common case, since Google/Microsoft rarely return gender). Both are
runtime values placed after the cached persona prefix; the persona prompt itself stays constant.

**Why this shape:** the expensive model runs exactly once per conversation, where the full Signal
set first lands and the answer matters most; the cheap model carries the chat and guards the topic
boundary before any spend. Follow-ups in a flatter Haiku voice are an accepted tradeoff — they are
short and factual ("prova 3–4 m, meta långsamt"), where persona matters least. This supersedes the
earlier draft of this ADR, which ran Sonnet on every advice turn.
