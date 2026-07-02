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
  "Jag snackar bara fiske, hörru. Fråga mig om sjöar, abborre eller gädda istället.";

/**
 * Chat-turn limit hit — deliberately a PLAIN system alert, NOT Fiskargubben's
 * voice (a system boundary).
 */
export const CHAT_LIMIT_MESSAGE =
  "Du har nått gränsen för den här chatten. Starta en ny chatt.";

/** Anon free-prompt exhausted → register to continue. */
export const ANON_REGISTER_MESSAGE =
  "Registrera dig för att fortsätta — anon-fisket är ett gratisprova, hörru.";

/** Lake could not be resolved from the user's message. */
export const LAKE_UNRESOLVED_MESSAGE =
  "Kände inte igen sjön du nämnde — kan du skriva sjönamnet tydligare, eventuellt med kommunen?";

/**
 * Several real lakes share the named body — ask WHICH one (by municipality)
 * instead of guessing. Fiskargubben's voice; lists the candidate municipalities
 * so the user can just answer with a kommun. Distinct from LAKE_UNRESOLVED
 * (that's "never heard of it"; this is "heard of several").
 */
export function lakeAmbiguousMessage(
  lakeName: string,
  municipalities: string[],
): string {
  const options = municipalities.join(", ");
  return `Det finns flera sjöar som heter ${lakeName}, hörru — vilken menar du? Säg kommunen: ${options}.`;
}

/** Free credits exhausted. */
export const OUT_OF_CREDITS_MESSAGE =
  "Du har förbrukat dina gratiskrediter — uppgradera för att fiska vidare.";
