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

  it("defines wind signal semantics (from vs toward)", () => {
    // The Tolken incident: without semantics the model inverted the wind
    // ("windwardShore: E" read as "wind from east") and flipped its shore
    // advice mid-conversation. The persona must define both fields and pin
    // the from/toward distinction.
    expect(FISKARGUBBEN_SYSTEM).toContain("windwardShore");
    expect(FISKARGUBBEN_SYSTEM).toContain("windDirection");
    expect(FISKARGUBBEN_SYSTEM).toContain("towardCompass");
    expect(/blåser.*MOT/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
    expect(
      /vind från väst betyder att östra stranden får driften/i.test(
        FISKARGUBBEN_SYSTEM,
      ),
    ).toBe(true);
  });

  it("requires compass directions to be written out in Swedish, never abbreviated", () => {
    // Users don't read meteorological shorthand: a reply saying "vinden
    // kommer från WNW" is noise to them. The prompt must carry the full
    // 16-point translation table and forbid abbreviations in replies.
    expect(/aldrig förkortningar/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
    expect(FISKARGUBBEN_SYSTEM).toContain("WNW = väst-nordväst");
    expect(FISKARGUBBEN_SYSTEM).toContain("NNE = nord-nordost");
    expect(FISKARGUBBEN_SYSTEM).toContain("SSW = syd-sydväst");
  });

  it("defines the remaining signal fields the model must interpret", () => {
    // Every unit/enum the snapshot carries needs a definition in the frozen
    // prompt — undefined fields get guessed (the cloudPct-octas and
    // windwardShore incidents both started as unexplained values).
    for (const field of [
      "cloudPct",
      "precipMmH",
      "windGustMs",
      "thunderPct",
      "visibilityKm",
      "lightWindow",
      "timeLocal",
      "speciesComfort",
      "sightDepthM",
      "provenance",
      "conditionsStaleMinutes",
    ]) {
      expect(FISKARGUBBEN_SYSTEM).toContain(field);
    }
    // Percent semantics for cloud cover must be pinned.
    expect(/molntäcke i procent/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
  });

  it("names the asked water honestly by kind — never assumes it is a lake", () => {
    // The "en sjö kallad Kalmar" incident: askedLakeName can carry a river,
    // coast or town name. The prompt must define askedWaterKind and forbid
    // calling a non-lake "sjö".
    expect(FISKARGUBBEN_SYSTEM).toContain("askedWaterKind");
    expect(/det vattnet/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
    expect(/älv är en älv/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
  });

  it("forbids guessing geography and species for unknown waters", () => {
    // The "Fjällsjöälven är en norrbottenälv" incident: general knowledge is
    // allowed, but confident geographic/species claims about waters outside
    // the signals are not.
    expect(/gissa (ALDRIG|aldrig)/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
    expect(/landskap|region/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
  });

  it("contains a tackle glossary covering colloquial and dialect terms", () => {
    // The "har svårt med svenskan: vobber, spinner, sidablänke" feedback —
    // the prompt must map colloquial angler vocabulary to standard terms and
    // tell the persona to mirror the user's own words.
    for (const term of ["vobbler", "spinnare", "sidablänke", "skeddrag"]) {
      expect(FISKARGUBBEN_SYSTEM).toContain(term);
    }
    expect(/rätta aldrig/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
  });

  it("bans good-luck wishes and mandates Skitfiske", () => {
    // Swedish angler superstition: wishing luck ("lycka till", "fiskelycka")
    // is a bad omen. The persona must wish well with "Skitfiske" variants
    // instead — never a literal good-luck phrase.
    expect(FISKARGUBBEN_SYSTEM).toContain("Skitfiske");
    expect(/önska (ALDRIG|aldrig).*lycka till/i.test(FISKARGUBBEN_SYSTEM)).toBe(
      true,
    );
    expect(/fiskelycka/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
    expect(/otur/i.test(FISKARGUBBEN_SYSTEM)).toBe(true);
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
