/**
 * swedish-time.ts — issue #7
 *
 * Resolve Swedish relative-time expressions (as returned free-text by the Haiku
 * Extractor: "ikväll", "imorgon", "på lördag", "kl 19", "om 3 dagar", …) into a
 * concrete target Date, relative to an INJECTED `now`.
 *
 * Design constraints:
 *  - Pure & deterministic: `now` is a required parameter — we never call
 *    Date.now() / new Date() with no args here, so every phrasing is unit-
 *    testable against a fixed clock.
 *  - Swedish wall-clock: day-part hours (kväll → 19:00, morgon → 07:00, …) are
 *    resolved in Europe/Stockholm (via the stockholm.ts helpers), NOT the
 *    server's local zone. "kl 19" therefore means 19:00 in Sweden on any host,
 *    including a UTC production server. Matches build.ts, which also reasons in
 *    the Stockholm wall-clock.
 *  - Valid-or-null contract: anything we cannot confidently resolve returns
 *    null, so the caller keeps its existing "valid-or-now" fallback (the C1
 *    guard in ask-handler) unchanged. We never throw and never return an
 *    Invalid Date.
 *
 * This replaces the naive `new Date(extraction.time)` parse, which treated
 * every Swedish phrase ("imorgon kväll") as Invalid Date → silently NOW, so
 * the forecast / light-window was computed for the wrong moment.
 */

import { stockholmParts, stockholmWallClockToUtc } from "@/lib/time/stockholm";

// ---------------------------------------------------------------------------
// Day-part → hour-of-day mapping (local time)
// ---------------------------------------------------------------------------

/**
 * Sensible representative hour for each Swedish part-of-day term. Fishing-
 * relevant, so dawn/dusk-ish parts point at the productive hour rather than the
 * literal midpoint (e.g. "morgon" → 07, "kväll" → 19).
 *
 * Order matters for matching: longer / more specific keys are checked first
 * (see PART_OF_DAY_KEYS) so "förmiddag" is not shadowed by "middag".
 */
const PART_OF_DAY: Record<string, number> = {
  gryning: 5, // dawn
  "morgon bitti": 7,
  morgon: 7,
  bitti: 7, // "bitti" only appears as "i morgon bitti" = early tomorrow
  förmiddag: 10,
  fm: 10,
  lunch: 12,
  middag: 12, // Swedish "vid middag" = midday here
  eftermiddag: 15,
  em: 15,
  kvällen: 19,
  kväll: 19,
  natten: 23,
  natt: 23,
};

// Match longest keys first so multi-word / compound parts win.
const PART_OF_DAY_KEYS = Object.keys(PART_OF_DAY).sort(
  (a, b) => b.length - a.length,
);

/** Default hour when a day is named with no part-of-day and no clock time. */
const DEFAULT_HOUR = 12;

// ---------------------------------------------------------------------------
// Swedish weekday names → 0=Sunday … 6=Saturday (matches Date.getDay()).
// ---------------------------------------------------------------------------

const WEEKDAYS: Record<string, number> = {
  söndag: 0,
  måndag: 1,
  tisdag: 2,
  onsdag: 3,
  torsdag: 4,
  fredag: 5,
  lördag: 6,
  // common ASCII fallbacks (in case diacritics are stripped upstream)
  sondag: 0,
  mandag: 1,
  lordag: 6,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a Swedish relative-time expression to a concrete Date.
 *
 * @param raw  The free-text time from the Extractor (may be undefined/empty).
 * @param now  The injected reference clock.
 * @returns A resolved Date, or null when the expression can't be understood
 *          (caller falls back to `now`).
 */
export function resolveSwedishTime(
  raw: string | undefined | null,
  now: Date,
): Date | null {
  if (!raw) return null;
  const text = normalize(raw);
  if (text.length === 0) return null;

  // A clock time ("kl 19", "19:00", "19.30") can accompany any day anchor;
  // extract it first so "imorgon kl 19" resolves the day AND the hour.
  const clock = parseClock(text);

  // ── 1. Day anchor: which calendar day? ──────────────────────────────────
  const dayOffset = resolveDayOffset(text, now);

  // ── 2. Part-of-day (only meaningful when no explicit clock time) ─────────
  // Strip the day-anchor words FIRST so the "morgon" inside "imorgon" /
  // "övermorgon" is not mistaken for the "morgon" (07:00) part-of-day.
  // Without this "imorgon kväll" would match morgon (07) instead of kväll (19).
  const part = clock === null ? matchPartOfDay(stripDayWords(text)) : null;

  // If we found nothing at all (no day anchor, no clock, no part), give up so
  // the caller keeps its NOW fallback rather than inventing a time.
  if (dayOffset === null && clock === null && part === null) {
    return null;
  }

  // Resolve against the SWEDISH wall-clock of `now`, not the server's local
  // zone: take now's Stockholm calendar day, shift by the day offset, set the
  // target hour/minute, then convert that Swedish wall-clock back to a UTC
  // instant (DST-correct). On a UTC server this is what makes "kl 19" mean
  // 19:00 in Sweden rather than 19:00 UTC.
  const base = stockholmParts(now);

  let hour: number;
  let minute = 0;
  if (clock !== null) {
    hour = clock.hour;
    minute = clock.minute;
  } else if (part !== null) {
    hour = part;
  } else {
    // A bare day ("imorgon", "på lördag") with no time → sensible default hour.
    hour = DEFAULT_HOUR;
  }

  // Apply the day offset on the calendar via a UTC-noon anchor (avoids any DST
  // hour-shift changing the date), then read the shifted Y/M/D back out.
  const shifted = new Date(
    Date.UTC(base.year, base.month - 1, base.day + (dayOffset ?? 0), 12, 0, 0),
  );
  const result = stockholmWallClockToUtc({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour,
    minute,
  });

  return Number.isNaN(result.getTime()) ? null : result;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Lowercase, collapse whitespace, trim. Keeps Swedish diacritics. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Resolve the calendar-day offset (in days) from `now`.
 *  - Returns 0 for today words / bare part-of-day (imorgon handled separately).
 *  - Returns null when no day anchor is present (so the caller can still apply
 *    a clock/part-of-day to *today*).
 */
function resolveDayOffset(text: string, now: Date): number | null {
  // "om N dagar" / "om en dag" — relative day count.
  const omMatch = text.match(/\bom (\d+|en|ett) dag(ar)?\b/);
  if (omMatch) {
    const n =
      omMatch[1] === "en" || omMatch[1] === "ett" ? 1 : Number(omMatch[1]);
    return Number.isFinite(n) ? n : null;
  }

  // Day-after-tomorrow before tomorrow, so "övermorgon" isn't caught by "morgon".
  // NB: no leading \b — "ö" is not an ASCII word char, so \b would not match a
  // string-initial "övermorgon".
  if (/(^|\s)(i )?övermorgon\b/.test(text)) {
    return 2;
  }

  // Tomorrow: "imorgon", "i morgon", "imorron", "i morron" (+ "bitti"/"kväll").
  if (/\bi ?mor(g?on|ron)\b/.test(text)) {
    return 1;
  }

  // Today: "idag", "i dag", "ikväll", "i kväll" etc. anchor to today (offset 0).
  if (
    /\bi ?dag\b/.test(text) ||
    /\bi ?kväll\b/.test(text) ||
    /\bi ?natt\b/.test(text) ||
    /\bi ?eftermiddag\b/.test(text) ||
    /\bi ?morse\b/.test(text)
  ) {
    return 0;
  }

  // Weekday: "på lördag", "nästa fredag", or a bare weekday name.
  const weekday = matchWeekday(text);
  if (weekday !== null) {
    // Swedish weekday of `now`, not the server-local one.
    return weekdayOffset(
      stockholmParts(now).weekday,
      weekday,
      /\bnästa\b/.test(text),
    );
  }

  return null;
}

/** Find a Swedish weekday number in the text, or null. */
function matchWeekday(text: string): number | null {
  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return dow;
  }
  return null;
}

/**
 * Days to add to reach the next occurrence of `target` weekday.
 *  - Same weekday as today resolves to +7 (next week), never "today", since a
 *    user naming a weekday means a future day.
 *  - "nästa" (next) pushes to next week's occurrence: today=Fri, "nästa fredag"
 *    → +7; today=Fri, "nästa lördag" → +8.
 */
function weekdayOffset(
  todayDow: number,
  target: number,
  next: boolean,
): number {
  let diff = (target - todayDow + 7) % 7;
  if (diff === 0) diff = 7; // named weekday is always in the future
  if (next && diff < 7) diff += 7;
  return diff;
}

/**
 * Remove the tomorrow / day-after-tomorrow words so their embedded "morgon"
 * substring can't be picked up as the "morgon" (07:00) part-of-day. "idag" is
 * stripped for symmetry (harmless — it has no day-part substring).
 */
function stripDayWords(text: string): string {
  return text
    .replace(/(^|\s)(i )?övermorgon\b/g, " ")
    .replace(/\bi ?mor(g?on|ron)\b/g, " ")
    .replace(/\bi ?dag\b/g, " ");
}

/** Return the day-part hour for the first matching term, or null. */
function matchPartOfDay(text: string): number | null {
  for (const key of PART_OF_DAY_KEYS) {
    if (text.includes(key)) return PART_OF_DAY[key];
  }
  return null;
}

/**
 * Parse an explicit clock time: "kl 19", "kl. 19", "klockan 19", "19:00",
 * "19.30", "07:05". Returns {hour, minute} or null.
 *
 * We require either a "kl"/"klockan" prefix OR a colon/dot minute separator so
 * a bare number that is actually a day count ("om 3 dagar") is not misread as
 * an hour.
 */
function parseClock(text: string): { hour: number; minute: number } | null {
  // "kl 19", "kl. 19:30", "klockan 7"
  const kl = text.match(/\bkl(?:ockan|\.)?\s*(\d{1,2})(?:[:.](\d{2}))?\b/);
  if (kl) {
    return clampClock(Number(kl[1]), kl[2] ? Number(kl[2]) : 0);
  }
  // "19:00", "19.30" — colon/dot form without prefix.
  const hm = text.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (hm) {
    return clampClock(Number(hm[1]), Number(hm[2]));
  }
  return null;
}

/** Reject out-of-range clock values (return null) rather than wrapping. */
function clampClock(
  hour: number,
  minute: number,
): { hour: number; minute: number } | null {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}
