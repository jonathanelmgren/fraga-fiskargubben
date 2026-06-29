import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/db/client", () => ({ db: {} }));

import { type AnalyticsEventType, emit } from "./events";

const types: AnalyticsEventType[] = [
  "lake_resolved",
  "lake_unresolved",
  "source_miss",
  "signals_built",
  "credit_spent",
  "topic_refused",
  "chat_limit_hit",
];

describe("analytics emit", () => {
  it("covers the taxonomy", () => expect(types).toHaveLength(7));
  it("inserts a row", async () => {
    const insert = vi
      .fn()
      .mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    await emit(
      { type: "lake_resolved", lakeId: "654321" },
      { db: { insert } as any },
    );
    expect(insert).toHaveBeenCalledOnce();
  });
});
