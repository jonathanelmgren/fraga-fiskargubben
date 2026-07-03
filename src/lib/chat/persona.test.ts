import { describe, expect, it } from "vitest";
import { FISKARGUBBEN_SYSTEM } from "./persona";

describe("FISKARGUBBEN_SYSTEM", () => {
  it("is FROZEN — contains no interpolation placeholders", () => {
    // Guards the prompt-cache prefix invariant (ADR-0003): the constant must be
    // byte-stable so Anthropic can cache it. Any ${…} would mean runtime data
    // was accidentally baked in.
    expect(FISKARGUBBEN_SYSTEM.includes("${")).toBe(false);
  });

  it("refuses clearly off-domain topics but allows weather/nature questions", () => {
    // Rebuild: the guard is loosened. Weather/water/nature questions get
    // straight answers; only clearly unrelated topics (code, homework,
    // politics) are refused in character.
    expect(/avvis/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
    expect(/programmering|läxor|politik/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
    expect(/väder/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
    // The old hard lock must be gone.
    expect(/BARA om fiske\. Inget annat/.test(FISKARGUBBEN_SYSTEM)).toBe(false);
  });

  it("contains honest area-only guidance (unresolved lake)", () => {
    expect(FISKARGUBBEN_SYSTEM).toContain("areaOnly");
    expect(/ärlig/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
    expect(/hitta (ALDRIG|aldrig) på/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
  });

  it("bans scripted catchphrases", () => {
    expect(/katchfraser|slagord/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
    // Known catchphrase examples must not be baked into the prompt.
    expect(FISKARGUBBEN_SYSTEM.includes("fiskarna vet om det")).toBe(false);
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
