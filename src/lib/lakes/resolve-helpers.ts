/**
 * Pure helpers for lake resolution — no DB, no server-only constraint.
 * Exported separately so they can be unit-tested without a DB.
 */

/**
 * Builds the canonical Lake label used everywhere in typeahead and responses.
 * Format: "name (municipality, county)"   (ADR-0002 / CONTEXT: Lake label)
 */
export function formatLabel(lake: {
  name: string;
  municipality: string;
  county: string;
}): string {
  return `${lake.name} (${lake.municipality}, ${lake.county})`;
}
