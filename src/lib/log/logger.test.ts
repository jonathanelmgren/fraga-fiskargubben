import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalServiceError } from "@/lib/errors";

vi.mock("@/lib/notify/discord", () => ({
  notifyDiscord: vi.fn().mockResolvedValue(undefined),
}));

import { notifyDiscord } from "@/lib/notify/discord";
import {
  logError,
  logWarn,
  newDigest,
  reportError,
  resetLoggerForTests,
  serializeError,
} from "./logger";

let logDir: string;

beforeEach(() => {
  logDir = mkdtempSync(path.join(tmpdir(), "fiskargubben-log-"));
  process.env.LOG_DIR = logDir;
  resetLoggerForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.LOG_DIR;
  resetLoggerForTests();
});

function readLog(): string {
  return readFileSync(path.join(logDir, "app.log"), "utf8");
}

describe("serializeError", () => {
  it("keeps stack, typed fields and the full cause chain", () => {
    const upstream = Object.assign(new Error("429 from Anthropic"), {
      status: 429,
    });
    const err = new ExternalServiceError("Extractor request failed", {
      service: "anthropic-extractor",
      status: 429,
      cause: upstream,
    });

    const s = serializeError(err) as Record<string, unknown>;
    expect(s.message).toBe("Extractor request failed");
    expect(s.service).toBe("anthropic-extractor");
    expect(s.status).toBe(429);
    expect(s.stack).toContain("Extractor request failed");
    const cause = s.cause as Record<string, unknown>;
    expect(cause.message).toBe("429 from Anthropic");
  });

  it("handles non-Error values", () => {
    expect(serializeError("boom")).toBe("boom");
    expect(serializeError({ weird: true })).toBe('{"weird":true}');
  });

  it("caps the cause chain depth", () => {
    let err: Error = new Error("leaf");
    for (let i = 0; i < 10; i++) {
      err = new Error(`level-${i}`, { cause: err });
    }
    // Must not throw / recurse forever.
    expect(() => serializeError(err)).not.toThrow();
  });
});

describe("digest correlation", () => {
  it("newDigest is 8 hex chars", () => {
    expect(newDigest()).toMatch(/^[0-9a-f]{8}$/);
  });

  it("logError writes the digest + serialized error to the logfile", () => {
    const digest = logError("test.scope", new Error("kaboom"), {
      prompt: "fiska i Tolken",
    });

    const line = readLog();
    expect(line).toContain(digest);
    expect(line).toContain("kaboom");
    expect(line).toContain("test.scope");
    expect(line).toContain("fiska i Tolken");
    expect(line).toContain("stack");
  });

  it("reportError pings Discord with the same digest that is in the file", () => {
    const digest = reportError("api/ask pipeline_error", new Error("boom"));

    expect(readLog()).toContain(digest);
    expect(vi.mocked(notifyDiscord)).toHaveBeenCalledWith(
      "alerts",
      expect.stringContaining(digest),
    );
    expect(vi.mocked(notifyDiscord)).toHaveBeenCalledWith(
      "alerts",
      expect.stringContaining("boom"),
    );
  });

  it("logWarn writes to the logfile without Discord", () => {
    logWarn("forecast", "cacheGet failed", { lakeId: "x" });
    expect(readLog()).toContain("cacheGet failed");
    expect(vi.mocked(notifyDiscord)).not.toHaveBeenCalled();
  });
});
