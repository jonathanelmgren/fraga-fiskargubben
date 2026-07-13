import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ExternalServiceError, TimeoutError } from "@/lib/errors";
import type { CandidateLake } from "./candidates";
import {
  MAX_RESOLVE_ATTEMPTS,
  RESOLVE_CONFIDENCE_THRESHOLD,
  resolveLakeWithHaiku,
} from "./haiku-resolver";

const candidates: CandidateLake[] = [
  {
    id: "lake-asunden-boras",
    name: "Åsunden",
    municipality: "Borås",
    county: "Västra Götaland",
    lat: 57.71,
    lon: 13.4,
    areaHa: 3300,
    distanceKm: 9.2,
  },
  {
    id: "lake-asunden-linkoping",
    name: "Åsunden",
    municipality: "Kinda",
    county: "Östergötland",
    lat: 57.99,
    lon: 15.75,
    areaHa: 5500,
  },
];

function buildMockClient(parsedOutput: unknown) {
  const parseSpy = vi.fn().mockResolvedValue({
    parsed_output: parsedOutput,
    stop_reason: "end_turn",
  });
  return { messages: { parse: parseSpy }, _parseSpy: parseSpy };
}

describe("resolveLakeWithHaiku", () => {
  it("constants match the spec", () => {
    expect(RESOLVE_CONFIDENCE_THRESHOLD).toBe(70);
    expect(MAX_RESOLVE_ATTEMPTS).toBe(3);
  });

  it("returns the picked candidate with confidence", async () => {
    const client = buildMockClient({
      lakeId: "lake-asunden-boras",
      confidence: 88,
      noSuchLake: false,
      clarifyQuestion: "Vilken kommun?",
    });
    const result = await resolveLakeWithHaiku({
      message: "hur nappar det i Åsunden i Ulricehamn?",
      lakeName: "Åsunden",
      municipality: "Ulricehamn",
      candidates,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });
    expect(result.lakeId).toBe("lake-asunden-boras");
    expect(result.confidence).toBe(88);
    expect(result.noSuchLake).toBe(false);
  });

  it("passes candidates, extraction and location to the model", async () => {
    const client = buildMockClient({
      lakeId: null,
      confidence: 10,
      noSuchLake: false,
      clarifyQuestion: "Vilken sjö?",
    });
    await resolveLakeWithHaiku({
      message: "Åsunden ikväll",
      lakeName: "Åsunden",
      municipality: "Ulricehamn",
      userLoc: { lat: 57.79, lon: 13.42 },
      candidates,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });
    const call = client._parseSpy.mock.calls[0][0];
    const content = call.messages[0].content as string;
    expect(content).toContain("lake-asunden-boras");
    expect(content).toContain("Kinda");
    expect(content).toContain("avstånd från användaren: 9.2 km");
    expect(content).toContain("57.790");
    expect(content).toContain("<user_message>");
  });

  it("low confidence passes through with clarify question", async () => {
    const client = buildMockClient({
      lakeId: "lake-asunden-boras",
      confidence: 35,
      noSuchLake: false,
      clarifyQuestion:
        "Vilken av dem menar du — den vid Borås eller den i Kinda?",
    });
    const result = await resolveLakeWithHaiku({
      message: "Åsunden",
      candidates,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });
    expect(result.confidence).toBe(35);
    expect(result.clarifyQuestion).toContain("Borås");
  });

  it("noSuchLake is passed through", async () => {
    const client = buildMockClient({
      lakeId: null,
      confidence: 90,
      noSuchLake: true,
      clarifyQuestion: "Det vattnet känner jag inte till.",
    });
    const result = await resolveLakeWithHaiku({
      message: "fiska i Atlantis-sjön",
      candidates: [],
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });
    expect(result.noSuchLake).toBe(true);
    expect(result.lakeId).toBeNull();
  });

  it("discards a hallucinated lakeId not in the candidate list", async () => {
    const client = buildMockClient({
      lakeId: "lake-made-up",
      confidence: 95,
      noSuchLake: false,
      clarifyQuestion: "Vilken sjö?",
    });
    const result = await resolveLakeWithHaiku({
      message: "Åsunden",
      candidates,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });
    expect(result.lakeId).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("parse failure → zero-confidence clarify fallback (no throw)", async () => {
    const client = buildMockClient(null);
    const result = await resolveLakeWithHaiku({
      message: "Åsunden",
      candidates,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });
    expect(result.lakeId).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.noSuchLake).toBe(false);
    expect(result.clarifyQuestion.length).toBeGreaterThan(0);
  });

  it("empty clarifyQuestion falls back to the canned one", async () => {
    const client = buildMockClient({
      lakeId: null,
      confidence: 20,
      noSuchLake: false,
      clarifyQuestion: "   ",
    });
    const result = await resolveLakeWithHaiku({
      message: "Åsunden",
      candidates,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });
    expect(result.clarifyQuestion.trim().length).toBeGreaterThan(0);
  });

  it("wraps a timeout as TimeoutError", async () => {
    const parseSpy = vi
      .fn()
      .mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    await expect(
      resolveLakeWithHaiku({
        message: "Åsunden",
        candidates,
        // biome-ignore lint/suspicious/noExplicitAny: test fake
        deps: { client: { messages: { parse: parseSpy } } as any },
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("wraps the SDK's APIUserAbortError (fired timeout signal) as TimeoutError", async () => {
    // What the real SDK throws when AbortSignal.timeout() fires: it swallows
    // the DOMException and raises APIUserAbortError ("Request was aborted.").
    // Digest a1f0f3fc logged this as a generic ExternalServiceError.
    const parseSpy = vi
      .fn()
      .mockRejectedValue(new Anthropic.APIUserAbortError());
    await expect(
      resolveLakeWithHaiku({
        message: "Åsunden",
        candidates,
        // biome-ignore lint/suspicious/noExplicitAny: test fake
        deps: { client: { messages: { parse: parseSpy } } as any },
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("wraps an API failure as ExternalServiceError with upstream status", async () => {
    const parseSpy = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("rate limited"), { status: 429 }),
      );
    await expect(
      resolveLakeWithHaiku({
        message: "Åsunden",
        candidates,
        // biome-ignore lint/suspicious/noExplicitAny: test fake
        deps: { client: { messages: { parse: parseSpy } } as any },
      }),
    ).rejects.toMatchObject({ status: 429 });
    const err = await resolveLakeWithHaiku({
      message: "Åsunden",
      candidates,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: { messages: { parse: parseSpy } } as any },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ExternalServiceError);
  });
});
