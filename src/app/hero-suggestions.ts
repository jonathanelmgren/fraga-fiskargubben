/**
 * Hero suggestion pools. Picked server-side per request (page.tsx calls
 * `connection()` first) so the chips rotate per visit with zero hydration
 * flash or layout shift.
 *
 * One chip per category per page load:
 *  - BROAD: big well-known waters and open-ended questions
 *  - SPECIFIC: water + town, showing that "sjön i orten" phrasing works
 *  - RIVER_SEA: rivers, coast and skärgård, showing scope beyond insjöar
 */

const BROAD_SUGGESTIONS = [
  "Vättern i helgen",
  "Vänern imorgon",
  "Gädda i Hjälmaren",
  "Abborre i Mälaren",
  "Tolken i kväll",
];

const SPECIFIC_SUGGESTIONS = [
  "Vänern i Mariestad",
  "Vänern i Karlstad",
  "Vättern i Hjo",
  "Åsunden i Ulricehamn",
  "Sommen vid Tranås",
];

const RIVER_SEA_SUGGESTIONS = [
  "Makrill i skärgården",
  "Lax i Mörrumsån",
  "Öring i Klarälven",
  "Havsöring på västkusten",
  "Ätran vid Falkenberg",
];

function pickRandom<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

export function pickHeroSuggestions(): string[] {
  return [
    pickRandom(BROAD_SUGGESTIONS),
    pickRandom(SPECIFIC_SUGGESTIONS),
    pickRandom(RIVER_SEA_SUGGESTIONS),
  ];
}
