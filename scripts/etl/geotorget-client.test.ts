import { describe, expect, it, vi } from "vitest";
import {
  basicAuthHeader,
  type DeliveryFile,
  GeotorgetClient,
} from "./geotorget-client";

const CFG = {
  orderId: "order-123",
  username: "sysuser",
  password: "secret",
};

const ROOT = "https://api.lantmateriet.se/geotorget/nedladdning/v1/order-123";

/** A fetch stub that records calls and returns queued JSON/bytes responses. */
function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return vi.fn((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  ) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("basicAuthHeader", () => {
  it("base64-encodes user:pass as HTTP Basic", () => {
    expect(basicAuthHeader("sysuser", "secret")).toBe(
      `Basic ${Buffer.from("sysuser:secret").toString("base64")}`,
    );
  });
});

describe("GeotorgetClient requests", () => {
  it("getOrder hits nedladdning/v1/{id} with the Basic auth header", async () => {
    let seenUrl = "";
    let seenAuth: string | null = null;
    const fetchImpl = mockFetch((url, init) => {
      seenUrl = url;
      seenAuth =
        (init?.headers as Record<string, string> | undefined)?.Authorization ??
        null;
      return jsonResponse({
        objektidentitet: CFG.orderId,
        produktnamn: "Topo",
      });
    });

    const client = new GeotorgetClient({ ...CFG, fetchImpl });
    const order = await client.getOrder();

    expect(order.produktnamn).toBe("Topo");
    expect(seenUrl).toBe(ROOT);
    expect(seenAuth).toBe(basicAuthHeader(CFG.username, CFG.password));
  });

  it("getLatestDelivery reads /leverans/latest", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toBe(`${ROOT}/leverans/latest`);
      return jsonResponse({ objektidentitet: "L1", status: "LYCKAD" });
    });
    const client = new GeotorgetClient({ ...CFG, fetchImpl });
    expect((await client.getLatestDelivery()).status).toBe("LYCKAD");
  });

  it("createDelivery POSTs /leverans?typ=BAS by default", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const fetchImpl = mockFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method ?? "GET";
      return jsonResponse({
        objektidentitet: "L1",
        status: "PÅGÅENDE",
        typ: "BAS",
      });
    });
    const client = new GeotorgetClient({ ...CFG, fetchImpl });
    const d = await client.createDelivery();
    expect(seenUrl).toBe(`${ROOT}/leverans?typ=BAS`);
    expect(seenMethod).toBe("POST");
    expect(d.status).toBe("PÅGÅENDE");
  });

  it("listFiles reads /leverans/latest/files", async () => {
    const files: DeliveryFile[] = [
      {
        path: "/leverans/latest/files/root/topografi_kn0000.zip?q=ENC",
        title: "topografi_kn0000.zip",
        type: "application/octet-stream",
        length: 123,
      },
    ];
    const fetchImpl = mockFetch((url) => {
      expect(url).toBe(`${ROOT}/leverans/latest/files`);
      return jsonResponse(files);
    });
    const client = new GeotorgetClient({ ...CFG, fetchImpl });
    expect(await client.listFiles()).toEqual(files);
  });

  it("downloadPath fetches {root}{path} and returns bytes", async () => {
    let seenUrl = "";
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = mockFetch((url) => {
      seenUrl = url;
      return new Response(bytes, { status: 200 });
    });
    const client = new GeotorgetClient({ ...CFG, fetchImpl });
    const out = await client.downloadPath(
      "/leverans/latest/files/root/a.zip?q=ENC",
    );
    expect(seenUrl).toBe(`${ROOT}/leverans/latest/files/root/a.zip?q=ENC`);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });

  it("listAllFiles recurses into application/json subdirectories", async () => {
    const root: DeliveryFile[] = [
      {
        path: "/f/a.zip?q=1",
        title: "a.zip",
        type: "application/octet-stream",
      },
      { path: "/f/sub?q=2", title: "sub", type: "application/json" },
    ];
    const sub: DeliveryFile[] = [
      {
        path: "/f/sub/b.zip?q=3",
        title: "b.zip",
        type: "application/octet-stream",
      },
    ];
    const fetchImpl = mockFetch((url) => {
      if (url.endsWith("/leverans/latest/files")) return jsonResponse(root);
      if (url.endsWith("/f/sub?q=2")) return jsonResponse(sub);
      return jsonResponse([]);
    });
    const client = new GeotorgetClient({ ...CFG, fetchImpl });
    const all = await client.listAllFiles();
    expect(all.map((f) => f.title)).toEqual(["a.zip", "b.zip"]);
  });

  it("throws on a non-OK response", async () => {
    const fetchImpl = mockFetch(() => new Response("nope", { status: 404 }));
    const client = new GeotorgetClient({ ...CFG, fetchImpl });
    await expect(client.getOrder()).rejects.toThrow(/404/);
  });

  it("honours the base-URL override", async () => {
    let seen = "";
    const fetchImpl = mockFetch((url) => {
      seen = url;
      return jsonResponse({ objektidentitet: "x", status: "LYCKAD" });
    });
    const client = new GeotorgetClient({
      ...CFG,
      baseUrl: "https://staging.example",
      fetchImpl,
    });
    await client.getLatestDelivery();
    expect(
      seen.startsWith("https://staging.example/geotorget/nedladdning/v1/"),
    ).toBe(true);
  });
});

describe("waitForDelivery", () => {
  const sleep = () => Promise.resolve();

  it("returns once LYCKAD after PÅGÅENDE polls", async () => {
    const statuses = ["PÅGÅENDE", "PÅGÅENDE", "LYCKAD"] as const;
    let i = 0;
    const fetchImpl = mockFetch(() =>
      jsonResponse({ objektidentitet: "L1", status: statuses[i++] }),
    );
    const client = new GeotorgetClient({ ...CFG, fetchImpl });
    const d = await client.waitForDelivery({
      intervalMs: 1,
      maxAttempts: 5,
      sleep,
    });
    expect(d.status).toBe("LYCKAD");
    expect(i).toBe(3);
  });

  it("throws on MISSLYCKAD", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ objektidentitet: "L1", status: "MISSLYCKAD" }),
    );
    const client = new GeotorgetClient({ ...CFG, fetchImpl });
    await expect(
      client.waitForDelivery({ intervalMs: 1, maxAttempts: 5, sleep }),
    ).rejects.toThrow(/MISSLYCKAD/);
  });

  it("throws when never ready within maxAttempts", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ objektidentitet: "L1", status: "PÅGÅENDE" }),
    );
    const client = new GeotorgetClient({ ...CFG, fetchImpl });
    await expect(
      client.waitForDelivery({ intervalMs: 1, maxAttempts: 3, sleep }),
    ).rejects.toThrow(/not ready after 3/);
  });
});
