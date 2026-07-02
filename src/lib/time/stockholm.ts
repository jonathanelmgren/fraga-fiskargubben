/**
 * stockholm.ts — everything in Fiskargubben's world is Swedish wall-clock time.
 *
 * A user standing at a lake at 00:00 means midnight in Sweden (Europe/Stockholm,
 * CEST/CET with DST), NOT 00:00 UTC and NOT the server's local zone. The signals
 * pipeline reasons about "kväll" / "natt" / a season, and the persona says
 * things like "klockan tio på kvällen" — all of that must be Swedish local, on
 * any host, regardless of the server's TZ env.
 *
 * `Date` is a UTC instant; the bug this fixes is FORMATTING it. `.toISOString()`
 * renders UTC ("22:00Z" for a 00:00-Stockholm instant in summer), so a field
 * named `timeLocal` was carrying UTC and the LLM read the wrong hour. These
 * helpers render/inspect an instant in Europe/Stockholm via Intl (DST-correct).
 */

const STOCKHOLM = "Europe/Stockholm";

/**
 * The Swedish wall-clock parts of an instant. Fields mean the same as the
 * matching Date getters, but evaluated in Europe/Stockholm rather than the
 * host's local zone or UTC. `weekday` is 0=Sunday…6=Saturday (like getDay()).
 */
export interface StockholmParts {
  year: number;
  /** 1-12 (human month, NOT the 0-based getMonth()). */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0=Sunday … 6=Saturday, matching Date.getDay(). */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// One formatter, reused: constructing Intl.DateTimeFormat is relatively costly
// and these run on the /api/ask hot path.
const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: STOCKHOLM,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hour12: false,
});

/** Decompose an instant into its Europe/Stockholm wall-clock parts. */
export function stockholmParts(date: Date): StockholmParts {
  const map: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Intl renders midnight as "24" with hour12:false — normalise to 0.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday] ?? 0,
  };
}

/**
 * Format an instant as a local Swedish wall-clock ISO string WITHOUT a zone
 * suffix, e.g. "2026-07-03T00:10:00". This is what the `timeLocal` signal
 * carries: the LLM reads it as the Swedish clock the angler is standing in.
 * No trailing "Z" — it is deliberately zone-less local time, not UTC.
 */
export function formatStockholmLocal(date: Date): string {
  const p = stockholmParts(date);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/**
 * The Europe/Stockholm UTC offset, in minutes, in effect at `date` (+120 during
 * CEST, +60 during CET). Positive = ahead of UTC. Lets callers convert a desired
 * Swedish wall-clock time into the correct UTC instant across DST.
 */
export function stockholmOffsetMinutes(date: Date): number {
  const p = stockholmParts(date);
  // Reconstruct the wall-clock as if it were UTC, then diff against the real
  // instant — the difference is the zone offset at that moment.
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  // Round to the nearest minute to shed the instant's sub-minute/second part.
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * Build the UTC instant for a Swedish wall-clock date/time. Given the intended
 * Stockholm calendar day + hour/minute, returns the Date whose Europe/Stockholm
 * rendering is exactly those parts (DST-correct). Used by the relative-time
 * resolver so "kl 19" means 19:00 in Sweden on any server.
 */
export function stockholmWallClockToUtc(parts: {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}): Date {
  // First guess: treat the wall-clock as UTC.
  const guessMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
  );
  // The offset at that instant tells us how far to shift back to real UTC.
  const offset = stockholmOffsetMinutes(new Date(guessMs));
  return new Date(guessMs - offset * 60000);
}
