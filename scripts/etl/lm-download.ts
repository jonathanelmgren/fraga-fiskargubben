/**
 * Download the Lantmäteriet Topografi delivery files to disk (streamed).
 *
 * Run:  pnpm etl:lm-download [file1.zip file2.zip ...]
 *
 * Lists the latest delivery's files via GeotorgetClient, then streams each
 * requested file (default: mark_sverige.zip + text_sverige.zip — the lake
 * polygons and their names) to LM_DOWNLOAD_DIR. The response is multi-GB, so it
 * is piped straight to a file, never buffered.
 *
 * Env: LM_ORDER_ID / LM_USERNAME / LM_PASSWORD (Geotorget), and optional
 * LM_DOWNLOAD_DIR (default ./.lm-data). Loaded from .env via
 * --env-file-if-exists in the package script.
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GeotorgetClient } from "./geotorget-client";

const DEFAULT_FILES = ["mark_sverige.zip", "text_sverige.zip"];

async function main(): Promise<void> {
  const orderId = process.env.LM_ORDER_ID;
  const username = process.env.LM_USERNAME;
  const password = process.env.LM_PASSWORD;
  if (!orderId || !username || !password) {
    console.error(
      "ERROR: LM_ORDER_ID / LM_USERNAME / LM_PASSWORD must be set (see .env.example).",
    );
    process.exit(1);
  }

  const outDir = process.env.LM_DOWNLOAD_DIR ?? ".lm-data";
  await mkdir(outDir, { recursive: true });

  const wanted = process.argv.slice(2);
  const targets = wanted.length > 0 ? wanted : DEFAULT_FILES;

  const client = new GeotorgetClient({ orderId, username, password });

  const delivery = await client.getLatestDelivery();
  console.log(
    `Delivery ${delivery.objektidentitet}: ${delivery.status} (${delivery.metadata?.humanReadableSize ?? "?"})`,
  );
  if (delivery.status !== "LYCKAD") {
    console.error(
      `ERROR: latest delivery is ${delivery.status}, not LYCKAD. Start/await a delivery first.`,
    );
    process.exit(1);
  }

  const files = await client.listAllFiles();
  const byTitle = new Map(files.map((f) => [f.title, f]));

  for (const title of targets) {
    const file = byTitle.get(title);
    if (!file) {
      console.warn(`Skipping ${title}: not in the delivery file list.`);
      continue;
    }
    const dest = join(outDir, title);
    console.log(`Downloading ${title} (${file.displaySize ?? "?"}) → ${dest}`);

    // Stream the response body straight to disk — never buffer the multi-GB file.
    const res = await client.rawDownload(file.path);
    if (!res.ok || res.body === null) {
      throw new Error(
        `Download ${title} failed: ${res.status} ${res.statusText}`,
      );
    }
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(dest),
    );
    console.log(`  done: ${title}`);
  }

  console.log("\nAll requested files downloaded.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
