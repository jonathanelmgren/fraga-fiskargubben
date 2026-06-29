/**
 * L8: single source of truth for the persona-critical Swedish gate strings.
 *
 * These were previously scattered across extractor.ts, quota.ts, and
 * ask-handler.ts.  Consolidating them here keeps Fiskargubben's voice
 * consistent and makes the copy reviewable in one place.  The original modules
 * re-export from here so existing import sites keep working.
 */

/** Off-topic refusal (extractor topic gate). */
export const CANNED_REFUSAL =
  "Jag snackar bara fiske, grabben. Fråga mig om sjöar, abborre eller gädda istället.";

/**
 * Chat-turn limit hit — deliberately a PLAIN system alert, NOT Fiskargubben's
 * voice (a system boundary).
 */
export const CHAT_LIMIT_MESSAGE =
  "Du har nått gränsen för den här chatten. Starta en ny chatt.";

/** Anon free-prompt exhausted → register to continue. */
export const ANON_REGISTER_MESSAGE =
  "Registrera dig för att fortsätta — anon-fisket är ett gratisprova, grabben.";

/** Lake could not be resolved from the user's message. */
export const LAKE_UNRESOLVED_MESSAGE =
  "kände inte igen sjön du nämnde — kan du skriva sjönamnet tydligare, eventuellt med kommunen?";

/** Free credits exhausted. */
export const OUT_OF_CREDITS_MESSAGE =
  "du har förbrukat dina gratiskrediter — uppgradera för att fiska vidare.";
