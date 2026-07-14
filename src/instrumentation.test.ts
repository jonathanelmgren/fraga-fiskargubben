/**
 * instrumentation.test.ts — onRequestError noise filters.
 *
 * Two classes of bot noise must never page the alerts channel: errors while
 * rendering /_not-found (path scans) and Next's router-state-header
 * validation errors (scanners POSTing garbage Next-Router-State-Tree
 * headers). Genuine render failures must still be reported.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportError, notifyDiscord } = vi.hoisted(() => ({
  reportError: vi.fn(),
  notifyDiscord: vi.fn(),
}));

vi.mock("@/lib/log/logger", () => ({ reportError }));
vi.mock("@/lib/notify/discord", () => ({ notifyDiscord }));

import { onRequestError } from "./instrumentation";

const request = {
  path: "/",
  method: "POST",
  headers: {},
} as Parameters<typeof onRequestError>[1];

const context = {
  routerKind: "App Router",
  routePath: "/page",
  routeType: "render",
} as Parameters<typeof onRequestError>[2];

beforeEach(() => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
});

afterEach(() => {
  vi.unstubAllEnvs();
  reportError.mockClear();
  notifyDiscord.mockClear();
});

describe("onRequestError", () => {
  it("ignores Next's router-state-header validation errors (scanner noise)", async () => {
    for (const message of [
      "The router state header was sent but could not be parsed.",
      "The router state header was too large.",
      "Multiple router state headers were sent. This is not allowed.",
    ]) {
      await onRequestError(new Error(message), request, context);
    }
    expect(reportError).not.toHaveBeenCalled();
    expect(notifyDiscord).not.toHaveBeenCalled();
  });

  it("ignores errors thrown while rendering the not-found page", async () => {
    await onRequestError(new Error("boom"), request, {
      ...context,
      routePath: "/_not-found",
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports genuine render failures", async () => {
    await onRequestError(new Error("db down"), request, context);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][0]).toBe("Serverfel POST /");
  });
});
