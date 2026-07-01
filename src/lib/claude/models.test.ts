import { describe, expect, it } from "vitest";
import { ADVICE_MODEL, EXTRACTOR_MODEL } from "./models";

describe("claude models", () => {
  it("uses Haiku 4.5 for extraction", () => {
    expect(EXTRACTOR_MODEL).toBe("claude-haiku-4-5");
  });
  it("uses Sonnet 4.6 for first-prompt advice", () => {
    expect(ADVICE_MODEL).toBe("claude-sonnet-4-6");
  });
});
