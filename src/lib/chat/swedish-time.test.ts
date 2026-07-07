/**
 * swedish-time.test.ts — issue #7
 *
 * Table-driven tests for resolveSwedishTime: Swedish relative-time phrasings →
 * expected concrete Date, against a FIXED injected `now`.
 *
 * Both `now` and every expected date are constructed as Europe/Stockholm
 * wall-clock instants (via stockholmWallClockToUtc), matching the parser, which
 * resolves in the Swedish zone. The suite is therefore genuinely TZ-independent
 * — it passes under any process TZ (dev GMT+2 or UTC prod).
 */

import { describe, expect, it } from "vitest";
import { stockholmWallClockToUtc } from "@/lib/time/stockholm";
import { resolveSwedishTime } from "./swedish-time";

// Fixed reference clock: Wednesday 2026-07-01, 14:30 SWEDISH time (CEST).
// Stockholm weekday === 3 (Wednesday). Mid-week so weekday math is unambiguous.
const NOW = stockholmWallClockToUtc({
  year: 2026,
  month: 7,
  day: 1,
  hour: 14,
  minute: 30,
});

/** Build an expected Swedish wall-clock Date: 2026-07-(1+offset) at hh:mm. */
function local(dayOffset: number, hour: number, minute = 0): Date {
  return stockholmWallClockToUtc({
    year: 2026,
    month: 7,
    day: 1 + dayOffset,
    hour,
    minute,
  });
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

  describe("late night: 'imorgon' past midnight means the day that already started", () => {
    // Prod incident 2026-07-06: user asked "Tolken imon förmiddag?" at 00:38
    // Swedish time — calendar-tomorrow resolved to July 8, but the user meant
    // "after I wake up" = July 7. SMHI said rain for the 7th; the answer
    // described the clear 8th. Before ~04:00 local, "imorgon" anchors to the
    // current calendar day.
    const LATE = stockholmWallClockToUtc({
      year: 2026,
      month: 7,
      day: 7,
      hour: 0,
      minute: 38,
    });
    const at = (day: number, hour: number) =>
      stockholmWallClockToUtc({ year: 2026, month: 7, day, hour, minute: 0 });

    it("imorgon förmiddag at 00:38 → same calendar day 10:00", () => {
      expectDate(resolveSwedishTime("imorgon förmiddag", LATE), at(7, 10));
    });
    it("imon (colloquial) at 00:38 → same calendar day", () => {
      expectDate(resolveSwedishTime("imon kl 13", LATE), at(7, 13));
    });
    it("övermorgon at 00:38 shifts one less too", () => {
      expectDate(resolveSwedishTime("övermorgon", LATE), at(8, 12));
    });
    it("ikväll at 00:38 stays on the current day", () => {
      expectDate(resolveSwedishTime("ikväll", LATE), at(7, 19));
    });
    it("imorgon at 09:00 is unaffected (normal calendar tomorrow)", () => {
      const morning = stockholmWallClockToUtc({
        year: 2026,
        month: 7,
        day: 7,
        hour: 9,
        minute: 0,
      });
      expectDate(resolveSwedishTime("imorgon", morning), at(8, 12));
    });
  });

  describe("approximate clock times (vid/runt/cirka N, N-tiden)", () => {
    // "Typ vid 11-12-13" (prod) parsed as NOTHING — parseClock required a kl
    // prefix or a colon. Accept common approximations; first number wins.
    const cases: Array<[string, Date]> = [
      ["imorgon vid 13", local(1, 13)],
      ["runt 13 imorgon", local(1, 13)],
      ["cirka 18 ikväll", local(0, 18)],
      ["ca 18", local(0, 18)],
      ["13-tiden imorgon", local(1, 13)],
      ["typ vid 11-12-13 imorgon", local(1, 11)],
    ];
    it.each(cases)("%s", (input, expected) => {
      expectDate(resolveSwedishTime(input, NOW), expected);
    });
    it("'om 3 dagar' is still a day count, not a clock", () => {
      expectDate(resolveSwedishTime("om 3 dagar", NOW), local(3, 12));
    });
  });

  describe("weekend (now = Wednesday 2026-07-01)", () => {
    it("i helgen → coming Saturday", () => {
      expectDate(resolveSwedishTime("i helgen", NOW), local(3, 12));
    });
    it("till helgen → coming Saturday", () => {
      expectDate(resolveSwedishTime("till helgen", NOW), local(3, 12));
    });
    it("helgen on a Saturday → that same day", () => {
      const saturday = stockholmWallClockToUtc({
        year: 2026,
        month: 7,
        day: 4,
        hour: 9,
        minute: 0,
      });
      expectDate(
        resolveSwedishTime("i helgen", saturday),
        stockholmWallClockToUtc({
          year: 2026,
          month: 7,
          day: 4,
          hour: 12,
          minute: 0,
        }),
      );
    });
  });

  describe("unparseable → null (caller keeps NOW fallback)", () => {
    // NB: "helgen" moved OUT of this list — it now resolves to Saturday
    // (see the weekend describe above).
    const cases = ["", "   ", "snart", "någon gång", "kl 99"];
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
