/**
 * Seed orchestrator — runs every ETL import in dependency order.
 *
 * Run:  pnpm seed:all
 *
 * Order (see scripts/etl/README.md):
 *   1. svar             → lakes            (MUST succeed first; everything joins lakes)
 *   2. metobs-stations  → metobs_station
 *   3. depth            → lake_depth
 *   4. mvm              → water_colour
 *   5. aqua             → lake_species
 *
 * Behaviour:
 *   - `svar` is the hard prerequisite: if it fails, the run ABORTS (a failed
 *     lakes seed makes every downstream join meaningless).
 *   - The remaining four sources are independent of each other, so a failure in
 *     one does NOT stop the others — each is attempted and the run ends with a
 *     summary. The process exits non-zero if ANY step failed, so CI/cron notices.
 *
 * Env: each child inherits this process's environment. Run via `pnpm seed:all`,
 * which loads `.env` (DATABASE_URL + VISS_APIKEY + MVM_TICKET) with
 * `tsx --env-file-if-exists=.env`.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ETL_DIR = dirname(fileURLToPath(import.meta.url));

interface Step {
  name: string;
  script: string;
  /** When true, a failure aborts the whole run (only `svar`). */
  prerequisite?: boolean;
}

const STEPS: Step[] = [
  { name: "svar", script: "import-svar.ts", prerequisite: true },
  { name: "metobs-stations", script: "import-metobs-stations.ts" },
  { name: "depth", script: "import-depth.ts" },
  { name: "mvm", script: "import-mvm.ts" },
  { name: "aqua", script: "import-aqua.ts" },
];

/** Run one ETL script as a child `tsx` process, inheriting stdio + env. */
function runStep(step: Step): boolean {
  const scriptPath = join(ETL_DIR, step.script);
  console.log(`\n━━━ seed:all → ${step.name} (${step.script}) ━━━`);
  const result = spawnSync(
    "npx",
    ["tsx", "--env-file-if-exists=.env", scriptPath],
    { stdio: "inherit", env: process.env },
  );
  // spawnSync returns status=null when the process was killed by a signal.
  return result.status === 0;
}

function main(): void {
  const failed: string[] = [];
  const succeeded: string[] = [];

  for (const step of STEPS) {
    const ok = runStep(step);
    if (ok) {
      succeeded.push(step.name);
      continue;
    }
    failed.push(step.name);
    if (step.prerequisite) {
      console.error(
        `\n✖ ${step.name} failed — it seeds the lakes table that every other ` +
          `source joins against. Aborting the rest of the seed.`,
      );
      break;
    }
    console.error(`\n✖ ${step.name} failed — continuing with the next source.`);
  }

  console.log("\n━━━ seed:all summary ━━━");
  console.log(`  ok:      ${succeeded.length ? succeeded.join(", ") : "none"}`);
  console.log(`  failed:  ${failed.length ? failed.join(", ") : "none"}`);

  if (failed.length > 0) process.exit(1);
  console.log("\n✔ all sources seeded.");
}

main();
