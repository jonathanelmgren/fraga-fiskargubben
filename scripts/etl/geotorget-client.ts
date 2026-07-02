/**
 * Lantmäteriet Geotorget download-API client (Geotorget Nedladdning v1).
 *
 * Used by the full-lake-coverage ETL to fetch the Topografi vektor (CC0)
 * GeoPackage that becomes the lake universe. All calls hit ONE host
 * (api.lantmateriet.se) under `/geotorget/nedladdning/v1/{OrderID}`, keyed by
 * the OrderID shown on the orderrad in Geotorget (Mitt konto → Ärenden). Note:
 * OrderID is the order's `objektidentitet`, NOT the `arendenummer`.
 *
 * Flow (Geotorget Nedladdning v1 spec):
 *   1. getOrder()          GET  .../v1/{id}                     → order info
 *   2. createDelivery()    POST .../v1/{id}/leverans?typ=BAS    → start a delivery
 *   3. getLatestDelivery() GET  .../v1/{id}/leverans/latest     → wait LYCKAD
 *   4. listFiles()         GET  .../v1/{id}/leverans/latest/files → [{path,title,type}]
 *   5. downloadPath(path)  GET  .../v1/{id}{path}               → bytes (octet-stream)
 *                                                                 or recurse (json)
 *
 * The files list is a TREE: `type: application/octet-stream` is a downloadable
 * file; `type: application/json` is a subdirectory whose `path` you re-query.
 * Each `path` carries a `?q={ENCRYPTED_STRING}` token and is relative to
 * `/geotorget/nedladdning/v1/{OrderID}`.
 *
 * Auth: HTTP Basic (username/password; the only method available to private
 * accounts). Injected, never hard-coded; the ETL reads LM_USERNAME/LM_PASSWORD
 * from env. This module has no DB/server-only imports and takes an injectable
 * `fetch` so it is unit-testable offline.
 */

export interface GeotorgetConfig {
  orderId: string;
  username: string;
  password: string;
  /** API host. Default: https://api.lantmateriet.se */
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://api.lantmateriet.se";

export type DeliveryStatus = "PÅGÅENDE" | "LYCKAD" | "MISSLYCKAD" | "MAKULERAD";

export interface Order {
  objektidentitet: string;
  produktnamn?: string;
  produktnr?: string;
  abonnemang?: boolean;
  status?: string;
  produktTyp?: string;
}

export interface Delivery {
  objektidentitet: string;
  status: DeliveryStatus;
  typ?: string;
  skapad?: string;
  uppdaterad?: string;
  metadata?: {
    size?: number;
    humanReadableSize?: string;
    lagringstid?: number;
  };
}

/**
 * One entry in a delivery's file tree.
 *   type "application/octet-stream" → a downloadable file (`path` fetches bytes)
 *   type "application/json"         → a subdirectory (`path` fetches more entries)
 * `path` is relative to /geotorget/nedladdning/v1/{OrderID} and carries a ?q= token.
 */
export interface DeliveryFile {
  path: string;
  title: string;
  type?: string;
  length?: number;
  displaySize?: string;
  updated?: string;
}

/**
 * Build the `Authorization: Basic …` header value from username/password.
 * Exported for testing; encodes exactly as HTTP Basic requires.
 */
export function basicAuthHeader(username: string, password: string): string {
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return `Basic ${token}`;
}

export class GeotorgetClient {
  private readonly orderId: string;
  private readonly auth: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GeotorgetConfig) {
    this.orderId = config.orderId;
    this.auth = basicAuthHeader(config.username, config.password);
    this.base = config.baseUrl ?? DEFAULT_BASE;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Base path for all order-scoped calls: /geotorget/nedladdning/v1/{OrderID}. */
  private orderRoot(): string {
    return `${this.base}/geotorget/nedladdning/v1/${enc(this.orderId)}`;
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: { Authorization: this.auth, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        `Geotorget ${res.status} ${res.statusText} for ${redact(url)}`,
      );
    }
    return (await res.json()) as T;
  }

  /** 1. Read the order (product name/number, status, subscription flag). */
  getOrder(): Promise<Order> {
    return this.getJson<Order>(this.orderRoot());
  }

  /**
   * 2. Start a new delivery. `typ` defaults to BAS (all data); FORANDRING
   * delivers only what changed since the last LYCKAD delivery (products that
   * support it). Valid when the order is AKTIV/NEDLADDNING and the last delivery
   * is LYCKAD/MISSLYCKAD/MAKULERAD.
   */
  async createDelivery(typ: "BAS" | "FORANDRING" = "BAS"): Promise<Delivery> {
    const res = await this.fetchImpl(
      `${this.orderRoot()}/leverans?typ=${typ}`,
      {
        method: "POST",
        headers: {
          Authorization: this.auth,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) {
      throw new Error(
        `Geotorget create-delivery ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as Delivery;
  }

  /** 3. Read the latest delivery — poll until `status === "LYCKAD"`. */
  getLatestDelivery(): Promise<Delivery> {
    return this.getJson<Delivery>(`${this.orderRoot()}/leverans/latest`);
  }

  /**
   * 4. List the file tree of the latest (successful) delivery. Entries with
   * `type: application/octet-stream` are files; `type: application/json` are
   * subdirectories — pass their `path` to listFilesAt to recurse.
   */
  listFiles(): Promise<DeliveryFile[]> {
    return this.getJson<DeliveryFile[]>(
      `${this.orderRoot()}/leverans/latest/files`,
    );
  }

  /**
   * List a subdirectory in the delivery tree, using a `path` returned by
   * listFiles (relative, carries the ?q= token). Returns the next level.
   */
  listFilesAt(path: string): Promise<DeliveryFile[]> {
    return this.getJson<DeliveryFile[]>(`${this.orderRoot()}${path}`);
  }

  /**
   * 5. Download one file's bytes, given its `path` from listFiles (relative,
   * with the ?q= token). Returns raw bytes; the caller unzips / writes to disk.
   * For multi-GB files use rawDownload() and stream the body to disk instead.
   */
  async downloadPath(path: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(`${this.orderRoot()}${path}`, {
      headers: { Authorization: this.auth },
    });
    if (!res.ok) {
      throw new Error(
        `Geotorget download ${res.status} ${res.statusText} for ${redact(path)}`,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Like downloadPath but returns the raw Response so the caller can STREAM the
   * body to disk (res.body) — required for the multi-GB Topografi zips, which
   * must not be buffered into memory.
   */
  rawDownload(path: string): Promise<Response> {
    return this.fetchImpl(`${this.orderRoot()}${path}`, {
      headers: { Authorization: this.auth },
    });
  }

  /**
   * Walk the delivery file tree, returning every downloadable (octet-stream)
   * file. Recurses into application/json subdirectories.
   */
  async listAllFiles(): Promise<DeliveryFile[]> {
    const out: DeliveryFile[] = [];
    const walk = async (entries: DeliveryFile[]): Promise<void> => {
      for (const e of entries) {
        if (e.type === "application/json") {
          await walk(await this.listFilesAt(e.path));
        } else {
          out.push(e);
        }
      }
    };
    await walk(await this.listFiles());
    return out;
  }

  /**
   * Poll getLatestDelivery until LYCKAD (or MISSLYCKAD → throw), waiting
   * `intervalMs` between polls up to `maxAttempts`. `sleep` is injectable so a
   * test can drive it without real timers.
   */
  async waitForDelivery(opts: {
    intervalMs: number;
    maxAttempts: number;
    sleep: (ms: number) => Promise<void>;
  }): Promise<Delivery> {
    for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
      const delivery = await this.getLatestDelivery();
      if (delivery.status === "LYCKAD") return delivery;
      if (delivery.status === "MISSLYCKAD" || delivery.status === "MAKULERAD") {
        throw new Error(
          `Geotorget delivery ${delivery.objektidentitet} ended ${delivery.status}`,
        );
      }
      await opts.sleep(opts.intervalMs);
    }
    throw new Error(
      `Geotorget delivery not ready after ${opts.maxAttempts} attempts`,
    );
  }
}

/** URL-encode a path segment (OrderID is user-supplied). */
function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/** Redact any basic-auth userinfo or token-ish query in a URL for logs. */
function redact(url: string): string {
  return url
    .replace(/\/\/[^@/]*@/, "//***@")
    .replace(/(token|apikey|key)=[^&]*/gi, "$1=***");
}
