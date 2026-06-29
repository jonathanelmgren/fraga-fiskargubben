// Model IDs are verified against the claude-api skill catalog (2026-06).
// Haiku 4.5 = extractor + topic gate + follow-up advice; Sonnet 4.6 = first-prompt advice. (ADR-0003)
export const EXTRACTOR_MODEL = "claude-haiku-4-5" as const;
export const ADVICE_MODEL = "claude-sonnet-4-6" as const;
export const FOLLOWUP_MODEL = "claude-haiku-4-5" as const;
