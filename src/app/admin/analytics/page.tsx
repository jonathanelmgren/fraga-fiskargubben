import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  type AnalyticsOverview,
  analyticsOverview,
  type Window,
} from "@/lib/analytics/queries";
import { getSession } from "@/lib/get-session";
import { isAdminEmail } from "@/lib/is-admin";

export const metadata: Metadata = {
  title: "Analytics — Fiskargubben admin",
};

// Always render fresh: this is an operational dashboard over an append-only
// table, so a cached snapshot would be misleading.
export const dynamic = "force-dynamic";

/** Preset windows, keyed by the `?range=` search param. */
const RANGES = {
  "24h": { label: "Senaste 24 h", hours: 24 },
  "7d": { label: "Senaste 7 dygn", hours: 24 * 7 },
  "30d": { label: "Senaste 30 dygn", hours: 24 * 30 },
  all: { label: "Allt", hours: null },
} as const;

type RangeKey = keyof typeof RANGES;

function resolveRange(raw: string | undefined): RangeKey {
  return raw && raw in RANGES ? (raw as RangeKey) : "7d";
}

function windowFor(range: RangeKey, now: Date): Window {
  const hours = RANGES[range].hours;
  if (hours === null) return {};
  return { since: new Date(now.getTime() - hours * 60 * 60 * 1000) };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export default async function AnalyticsDashboard({
  searchParams,
}: {
  // Next 16: searchParams is async.
  searchParams: Promise<{ range?: string }>;
}) {
  // Auth gate (ADR-0005 read-side).  notFound() rather than a 403 so the page's
  // existence isn't disclosed to non-admins.
  const session = await getSession();
  if (!isAdminEmail(session?.user.email)) {
    notFound();
  }

  const { range: rawRange } = await searchParams;
  const range = resolveRange(rawRange);
  const data = await analyticsOverview(windowFor(range, new Date()));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 space-y-8">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Read-side view over <code>analytics_event</code> (ADR-0005).
          Append-only; no external pipeline.
        </p>
        <nav className="flex flex-wrap gap-2 text-xs">
          {(Object.keys(RANGES) as RangeKey[]).map((key) => (
            <Link
              key={key}
              href={`/admin/analytics?range=${key}`}
              className={`rounded-md border px-3 py-1.5 font-medium transition-colors ${
                key === range
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:bg-secondary"
              }`}
            >
              {RANGES[key].label}
            </Link>
          ))}
        </nav>
      </header>

      <Overview data={data} />
    </main>
  );
}

function Overview({ data }: { data: AnalyticsOverview }) {
  return (
    <div className="space-y-8">
      {/* Headline tiles */}
      <section className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Lakes resolved" value={data.resolution.resolved} />
        <Stat label="Lakes unresolved" value={data.resolution.unresolved} />
        <Stat
          label="Unresolved rate"
          value={pct(data.resolution.unresolvedRate)}
        />
        <Stat label="Credits spent" value={data.credits.totalCredits} />
        <Stat label="Distinct spenders" value={data.credits.distinctUsers} />
        <Stat label="Topic refusals" value={data.topicRefusals} />
        <Stat label="Chat-limit hits" value={data.chatLimitHits} />
        <Stat
          label="Persistence failures"
          value={data.persistenceFailures}
          alert={data.persistenceFailures > 0}
        />
      </section>

      {/* Gate funnel */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight">Gate funnel</h2>
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Register gate" value={data.registerGates} />
          <Stat label="Lake lock" value={data.lakeLocks} />
          <Stat label="Out of credits" value={data.outOfCredits} />
        </div>
      </section>

      {/* Top lakes */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Top lakes asked
        </h2>
        {data.topLakes.length === 0 ? (
          <Empty />
        ) : (
          <Table
            head={["Lake", "Municipality", "County", "Resolved"]}
            rows={data.topLakes.map((l) => ({
              key: l.lakeId,
              cells: [
                l.name ?? l.lakeId,
                l.municipality ?? "—",
                l.county ?? "—",
                String(l.resolvedCount),
              ],
            }))}
          />
        )}
      </section>

      {/* Source misses */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Source misses (by source &amp; reason)
        </h2>
        {data.sourceMisses.length === 0 ? (
          <Empty />
        ) : (
          <Table
            head={["Source", "Total", "error", "empty", "no_row"]}
            rows={data.sourceMisses.map((s) => ({
              key: s.source,
              cells: [
                s.source,
                String(s.misses),
                String(s.errorCount),
                String(s.emptyCount),
                String(s.noRowCount),
              ],
            }))}
          />
        )}
      </section>

      {/* All event types */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight">
          All events by type
        </h2>
        {data.byType.length === 0 ? (
          <Empty />
        ) : (
          <Table
            head={["Type", "Count"]}
            rows={data.byType.map((e) => ({
              key: e.type,
              cells: [e.type, String(e.count)],
            }))}
          />
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  alert = false,
}: {
  label: string;
  value: string | number;
  alert?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/50 px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          alert ? "text-destructive" : "text-foreground"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/** A table row carries a stable domain key (lakeId / source / type) so React
 * reconciles by identity, not array position — and cells key off the column
 * header, which is unique per table. */
interface Row {
  key: string;
  cells: string[];
}

function Table({ head, rows }: { head: string[]; rows: Row[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-secondary/40 text-left">
            {head.map((h) => (
              <th
                key={h}
                className="px-3 py-2 font-medium text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-0">
              {row.cells.map((cell, j) => (
                <td
                  key={head[j] ?? `col-${j}`}
                  className="px-3 py-2 tabular-nums"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Empty() {
  return (
    <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      Inga händelser i valt tidsfönster.
    </p>
  );
}
