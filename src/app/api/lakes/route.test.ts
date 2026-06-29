// vi.mock calls are hoisted — run before imports.
import { vi } from "vitest";

// Allow server-only imports in the test environment.
vi.mock("server-only", () => ({}));

// Stub env so Zod validation doesn't blow up on missing secrets.
vi.mock("@/shared/env", () => ({
  env: {
    DATABASE_URL: "postgres://localhost/fiskargubben",
    ANTHROPIC_API_KEY: "test",
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-chars!!",
    BETTER_AUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "test",
    GOOGLE_CLIENT_SECRET: "test",
    MICROSOFT_CLIENT_ID: "test",
    MICROSOFT_CLIENT_SECRET: "test",
  },
}));

// Mock searchLakes so the route test is pure unit (no DB needed).
vi.mock("@/lib/lakes/resolve", () => ({
  searchLakes: vi.fn(),
}));

import { afterEach, describe, expect, it } from "vitest";
import { searchLakes } from "@/lib/lakes/resolve";
import { GET } from "./route";

const mockSearchLakes = vi.mocked(searchLakes);

const FIXTURE = [
  {
    id: "abc",
    name: "Tolken",
    label: "Tolken (Ulricehamn, Västra Götaland)",
    lat: 57.7,
    lon: 13.4,
  },
];

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/lakes", () => {
  it("returns 200 and empty array when q is missing", async () => {
    const req = new Request("http://x/api/lakes");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
    expect(mockSearchLakes).not.toHaveBeenCalled();
  });

  it("returns 200 and empty array when q is an empty string", async () => {
    const req = new Request("http://x/api/lakes?q=");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
    expect(mockSearchLakes).not.toHaveBeenCalled();
  });

  it("delegates to searchLakes(q) and returns its result as JSON", async () => {
    mockSearchLakes.mockResolvedValueOnce(FIXTURE);
    const req = new Request("http://x/api/lakes?q=tol");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(mockSearchLakes).toHaveBeenCalledWith("tol");
    const body = await res.json();
    expect(body).toEqual(FIXTURE);
  });

  it("response has application/json content-type", async () => {
    mockSearchLakes.mockResolvedValueOnce(FIXTURE);
    const req = new Request("http://x/api/lakes?q=tol");
    const res = await GET(req);

    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });
});
