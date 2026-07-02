/**
 * swedish-time.test.ts — issue #7
 *
 * Table-driven tests for resolveSwedishTime: Swedish relative-time phrasings →
 * expected concrete Date, against a FIXED injected `now`.
 *
 * All dates are constructed with the local Date(...) constructor and asserted
 * against local-field getters, so the suite is timezone-agnostic: the parser
 * uses local setDate/setHours, and so do these expectations.
 */

import { describe, expect, it } from "vitest";
import { resolveSwedishTime } from "./swedish-time";

// Fixed reference clock: Wednesday 2026-07-01, 14:30 local time.
// getDay() === 3 (Wednesday). Chosen mid-week so weekday math is unambiguous.
const NOW = new Date(2026, 6, 1, 14, 30, 0, 0);

/** Build an expected local Date: `now`'s date + dayOffset, at hh:mm. */
function local(dayOffset: number, hour: number, minute = 0): Date {
  return new Date(2026, 6, 1 + dayOffset, hour, minute, 0, 0);
}

/** Assert a resolved Date equals the expected local wall-clock. */
function expectDate(actual: Date | null, expected: Date) {
  expect(actual).not.toBeNull();
  expect(actual?.getTime()).toBe(expected.getTime());
}

describe("resolveSwedishTime", () => {
  describe("today + part-of-day", () => {
    const cases: Array<[string, Date]> = [
      ["ikväll", local(0, 19)],
      ["i kväll", local(0, 19)],
      ["idag", local(0, 12)],
      ["i dag", local(0, 12)],
      ["i eftermiddag", local(0, 15)],
      ["inatt", local(0, 23)],
      ["i natt", local(0, 23)],
      ["på morgonen", local(0, 7)],
      ["vid lunch", local(0, 12)],
      ["på förmiddagen", local(0, 10)],
    ];
    it.each(cases)("%s", (input, expected) => {
      expectDate(resolveSwedishTime(input, NOW), expected);
    });
  });

  describe("tomorrow + part-of-day", () => {
    const cases: Array<[string, Date]> = [
      ["imorgon", local(1, 12)],
      ["i morgon", local(1, 12)],
      ["imorgon kväll", local(1, 19)],
      ["i morgon kväll", local(1, 19)],
      ["imorgon bitti", local(1, 7)],
      ["i morgon bitti", local(1, 7)],
      ["imorgon eftermiddag", local(1, 15)],
      ["imorron", local(1, 12)],
    ];
    it.each(cases)("%s", (input, expected) => {
      expectDate(resolveSwedishTime(input, NOW), expected);
    });
  });

  describe("day after tomorrow", () => {
    it("övermorgon", () => {
      expectDate(resolveSwedishTime("övermorgon", NOW), local(2, 12));
    });
    it("i övermorgon kväll", () => {
      expectDate(resolveSwedishTime("i övermorgon kväll", NOW), local(2, 19));
    });
  });

  describe("weekdays (now = Wednesday 2026-07-01)", () => {
    // Wed → next Sat is +3 (2026-07-04); next Wed is +7.
    const cases: Array<[string, Date]> = [
      ["på lördag", local(3, 12)], // Sat, this week
      ["lördag", local(3, 12)],
      ["på fredag", local(2, 12)], // Fri, this week
      ["på måndag", local(5, 12)], // next Mon
      ["på onsdag", local(7, 12)], // same weekday → next week, never today
      ["på lördag kväll", local(3, 19)],
      ["på lördag kl 06", local(3, 6)],
    ];
    it.each(cases)("%s", (input, expected) => {
      expectDate(resolveSwedishTime(input, NOW), expected);
    });
  });

  describe('"nästa" weekday', () => {
    // now = Wed. "nästa fredag": plain Fri is +2 (this week) → bumped to +9.
    it("nästa fredag → next week", () => {
      expectDate(resolveSwedishTime("nästa fredag", NOW), local(9, 12));
    });
    // "nästa onsdag": same weekday, plain diff is +7 (already next) → stays +7.
    it("nästa onsdag → +7", () => {
      expectDate(resolveSwedishTime("nästa onsdag", NOW), local(7, 12));
    });
  });

  describe('"om N dagar"', () => {
    const cases: Array<[string, Date]> = [
      ["om 3 dagar", local(3, 12)],
      ["om 1 dag", local(1, 12)],
      ["om en dag", local(1, 12)],
      ["om 10 dagar", local(10, 12)],
      ["om 2 dagar på kvällen", local(2, 19)],
    ];
    it.each(cases)("%s", (input, expected) => {
      expectDate(resolveSwedishTime(input, NOW), expected);
    });
  });

  describe("explicit clock times", () => {
    const cases: Array<[string, Date]> = [
      ["kl 19", local(0, 19)],
      ["kl. 19", local(0, 19)],
      ["klockan 7", local(0, 7)],
      ["19:00", local(0, 19)],
      ["19.30", local(0, 19, 30)],
      ["07:05", local(0, 7, 5)],
      ["imorgon kl 19", local(1, 19)],
      ["imorgon 19:00", local(1, 19)],
      ["på lördag klockan 06:30", local(3, 6, 30)],
      ["kl 19 imorgon", local(1, 19)], // order-independent
    ];
    it.each(cases)("%s", (input, expected) => {
      expectDate(resolveSwedishTime(input, NOW), expected);
    });
  });

  describe("unparseable → null (caller keeps NOW fallback)", () => {
    const cases = ["", "   ", "snart", "någon gång", "helgen typ", "kl 99"];
    it.each(cases)("%j → null", (input) => {
      expect(resolveSwedishTime(input, NOW)).toBeNull();
    });

    it("undefined → null", () => {
      expect(resolveSwedishTime(undefined, NOW)).toBeNull();
    });
    it("null → null", () => {
      expect(resolveSwedishTime(null, NOW)).toBeNull();
    });
  });

  describe("determinism (does not read the real clock)", () => {
    it("same input + same now → identical result", () => {
      const a = resolveSwedishTime("imorgon kväll", NOW);
      const b = resolveSwedishTime("imorgon kväll", NOW);
      expect(a?.getTime()).toBe(b?.getTime());
    });
    it("result is relative to injected now, not Date.now()", () => {
      const otherNow = new Date(2020, 0, 15, 9, 0, 0, 0); // Wed 2020-01-15
      const r = resolveSwedishTime("imorgon", otherNow);
      expect(r?.getFullYear()).toBe(2020);
      expect(r?.getMonth()).toBe(0);
      expect(r?.getDate()).toBe(16);
    });
  });
});
