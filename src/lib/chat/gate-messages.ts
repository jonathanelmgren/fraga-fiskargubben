/**
 * L8: single source of truth for the persona-critical Swedish gate strings.
 *
 * These were previously scattered across extractor.ts, quota.ts, and
 * ask-handler.ts.  Consolidating them here keeps Fiskargubben's voice
 * consistent and makes the copy reviewable in one place.  The original modules
 * re-export from here so existing import sites keep working.
 *
 * Copy rules (2026-07-05): no tankstreck, warm rather than gruff, plain
 * sentences a human would say.
 */

/**
 * Off-topic refusal (extractor topic gate). Rebuild: the gate is loosened —
 * weather/water/nature questions pass — so the refusal names what IS in scope.
 */
export const CANNED_REFUSAL =
  "Det där kan jag för lite om, hörru. Men fråga mig gärna om fiske, väder eller vatten.";

/**
 * Chat-turn limit hit — deliberately a PLAIN system alert, NOT Fiskargubben's
 * voice (a system boundary).
 */
export const CHAT_LIMIT_MESSAGE =
  "Du har nått gränsen för den här chatten. Starta en ny chatt, eller uppgradera till premium för obegränsade följdfrågor.";

/** Anon free-prompt exhausted → register to continue. */
export const ANON_REGISTER_MESSAGE =
  "Första frågan bjuder jag på. Skapa ett konto så fortsätter vi prata fiske.";

/** Lake could not be resolved from the user's message. */
export const LAKE_UNRESOLVED_MESSAGE =
  "Jag kände inte igen sjön du nämnde. Kan du skriva namnet tydligare, gärna med kommunen?";

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
  return `Det finns flera sjöar som heter ${lakeName}. Vilken menar du? Säg kommunen: ${options}.`;
}

/**
 * Fallback clarify question when the Haiku resolver could not produce one
 * (parse failure). In-persona; used by the free clarify rounds of the
 * lake-resolution lifecycle.
 */
export const LAKE_CLARIFY_FALLBACK =
  "Vilket vatten gäller det? Säg namnet och kommunen eller närmaste ort så hänger jag med.";

/** Free credits exhausted. */
export const OUT_OF_CREDITS_MESSAGE =
  "Dina gratisfrågor är slut för den här gången. Uppgradera så fiskar vi vidare.";
