import { describe, expect, it } from "vitest";
import { FISKARGUBBEN_SYSTEM } from "./persona";

describe("FISKARGUBBEN_SYSTEM", () => {
  it("is FROZEN — contains no interpolation placeholders", () => {
    // Guards the prompt-cache prefix invariant (ADR-0003): the constant must be
    // byte-stable so Anthropic can cache it. Any ${…} would mean runtime data
    // was accidentally baked in.
    expect(FISKARGUBBEN_SYSTEM.includes("${")).toBe(false);
  });

  it("contains a fishing-only / refuse-off-topic instruction", () => {
    // The persona must decline non-fishing questions in character.
    // We accept any of several natural Swedish phrases that encode this rule.
    const hasFishingLock =
      /fisk/i.test(FISKARGUBBEN_SYSTEM) &&
      (/avvis|vägra|avböj|inte svar|tackar nej|håller sig|bara (om|till) fisk|bara fisk|enbart fisk/i.test(
        FISKARGUBBEN_SYSTEM,
      ) ||
        /inget annat/i.test(FISKARGUBBEN_SYSTEM));
    expect(hasFishingLock).toBe(true);
  });

  it("contains gender-neutrality instruction", () => {
    // Must NOT assume gender; must use neutral address unless gender is supplied
    // from the IdP. Look for key Swedish terms used in CONTEXT.md.
    const hasNeutralInstruction =
      /hörru|du där|kompis/i.test(FISKARGUBBEN_SYSTEM) &&
      /kön|genus|neutral/i.test(FISKARGUBBEN_SYSTEM);
    expect(hasNeutralInstruction).toBe(true);
  });

  it("contains wind-down sign-off guidance", () => {
    // When windingDown flag is set (passed in the user turn), persona should
    // keep replies short and start signing off.
    const hasWindDown =
      /wind.?down|vindvar|avslutar|lycka till|vänt på det|avslutning|kortare/i.test(
        FISKARGUBBEN_SYSTEM,
      );
    expect(hasWindDown).toBe(true);
  });
});
