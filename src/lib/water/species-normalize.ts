/**
 * Pure species-name normalization — NO `server-only`, NO DB.
 *
 * Split out of `species.ts` (which is `server-only` because of `speciesFor`'s
 * DB access) so the ETL script `import-aqua.ts` can import it under plain `tsx`
 * without tripping the `server-only` guard. `species.ts` re-exports this for
 * existing runtime call sites.
 */

/**
 * Normalize a raw species list:
 *  - Trim surrounding whitespace.
 *  - Convert to lower case.
 *  - Filter out blank / whitespace-only entries.
 *  - Deduplicate (preserving first-occurrence order).
 */
export function normalizeSpecies(rawList: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of rawList) {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}
