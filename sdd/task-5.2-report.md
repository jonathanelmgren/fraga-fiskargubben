# Task 5.2 Report: Extractor (Haiku structured output + topic gate)

## What was built

`src/lib/chat/extractor.ts` — `extract(message, history?, deps?): Promise<Extraction>`

`src/lib/chat/extractor.test.ts` — 6 Vitest tests, all green.

## Key design decisions

### Canned refusal string

When `onTopic === false` (either from model output or `parsed_output: null` fallback), a
hardcoded in-persona Swedish string is set in code:

```
"Jag snackar bara fiske, grabben. Fråga mig om sjöar, abborre eller gädda istället."
```

**Rationale:** Asking the model to produce the refusal text each time would waste output
tokens on a deterministic string, and the result would vary in tone. Hardcoding ensures
consistent persona and zero extra cost for off-topic requests (ADR-0004 topic gate).

### `parsed_output: null` handling

Return `{ onTopic: false, contextChanged: false, refusal: CANNED_REFUSAL }` — treated
identically to an explicit off-topic result. No throw, no crash. This keeps the caller's
code path simple: it always checks `onTopic`, regardless of parse success.

Alternative considered: throw a typed error. Rejected — callers would need a try/catch
that ultimately does the same thing (emit `topic_refused`, skip Credits).

### `zodOutputFormat` signature

The installed SDK version (`@anthropic-ai/sdk ^0.107.0`) exports `zodOutputFormat` as a
1-argument function `zodOutputFormat(schema)`. The 2-argument form `(schema, name)` from
older documentation is absent in this version — confirmed by reading `helpers/zod.d.ts`
directly after `tsgo` flagged `Expected 1 arguments, but got 2`.

### Lazy `env` import

`src/shared/env.ts` validates `process.env` at module evaluation time and throws if vars
are absent. In test environments none are set. The extractor defers the import to
`defaultClient()` (called only when `deps.client` is not injected), so tests that inject
a mock client never touch `env.ts`.

### Dependency injection

`deps?: { client: Pick<Anthropic, "messages"> }` — tests inject a `vi.fn()` spy.
Production path calls `defaultClient()` which lazily constructs a real `Anthropic` client.

## Tests (6/6 pass)

1. On-topic fishing message → `onTopic: true` + all parsed fields populated
2. Off-topic message → `onTopic: false` + truthy in-persona refusal string
3. `contextChanged` surfaced correctly from model output
4. `parsed_output: null` → off-topic fallback with refusal, no crash
5. Calls exactly `EXTRACTOR_MODEL` = `"claude-haiku-4-5"`
6. Does NOT pass `thinking`, does NOT pass `effort` inside `output_config`,
   last message role is not `"assistant"` (no prefill)

## CI status

- `pnpm test src/lib/chat/extractor.test.ts` — 6 passed
- `pnpm ts:check` — clean
- `pnpm biome` — 3 warnings in pre-existing files (`analytics/events.test.ts`,
  `water/temp.test.ts`); 0 issues in new files
