# Analytics: dashboards (built) + external tooling & retention (proposal)

Status: **in-repo dashboards built; external tooling deferred (recommendation only).**
Follows ADR-0005 (`docs/adr/0005-analytics-events-table-now-dashboards-later.md`), which
captured structured events to the append-only `analytics_event` table up front and explicitly
deferred dashboards, aggregation, and external analytics to a read-side follow-up. This document is
that follow-up. It records what was built now and proposes — but does not implement — external
tooling and a retention policy.

## What was built (this pass)

Pure read-side, no change to the emit pipeline (`src/lib/analytics/events.ts`):

- **Aggregation layer** — `src/lib/analytics/queries.ts`: typed query functions over
  `analytics_event`, in the repo's raw-SQL idiom (`db.execute<Row>(sql\`\`)`, injectable `deps` for
  tests). Answers the ADR-0005 questions:
  - `topLakesAsked` — top lakes by `lake_resolved` volume (joined to `lakes` for labels).
  - `unresolvedLakeRate` — `lake_unresolved` / (`lake_resolved` + `lake_unresolved`).
  - `sourceMissBreakdown` — `source_miss` grouped by `payload.source`, split by `payload.reason`
    (`error` / `empty` / `no_row`).
  - `creditSpend` — total `credit_spent` events + distinct `payload.userId`.
  - `countByType` / `eventCountsByType` — topic refusals, chat-limit hits, the H7 gate funnel
    (`register_gate`, `lake_lock`, `out_of_credits`), H4 `persistence_failure`, and a catch-all
    histogram so any new emit type surfaces without code changes.
  - `analyticsOverview` — fans all of the above out concurrently for the dashboard.
- **Admin dashboard** — `src/app/admin/analytics/page.tsx`: server component with a
  24h / 7d / 30d / all window selector (`?range=`), `force-dynamic`.
- **Admin gate** — `src/lib/is-admin.ts` + `ADMIN_EMAILS` env allowlist. The user schema has **no
  role/isAdmin column**, so authorization is a comma-separated email allowlist checked against the
  Better Auth session; non-admins get `notFound()` (the page's existence is not disclosed).

### Known limitation of the current gate

`ADMIN_EMAILS` is the minimal viable gate. If admin surfaces grow past this one read-only page, add a
`role`/`isAdmin` column (or the Better Auth admin plugin) and switch `isAdminEmail` to a DB check.
Until then, keep the allowlist short and treat it as operator-only.

## Recommendation: external analytics tooling

**Recommendation: stay SQL-only (the in-repo dashboard above) for now. Reassess against the trigger
below.** Rationale: ADR-0005 deliberately avoided an analytics vendor before the product is proven,
the event volume is currently low, and Postgres is already the datastore. The dashboard answers every
question ADR-0005 named without new infrastructure, a new SDK, or a new data egress/privacy surface.

Option comparison (for when the trigger fires):

| Option | Fit here | Cost / risk |
| --- | --- | --- |
| **SQL-only (current)** | Everything ADR-0005 asked for; zero new infra; data stays in one place. | Manual query work for new questions; no funnels/retention UI; no client-side events. |
| **Metabase** (self-host) | Points straight at the same Postgres; non-eng can build charts; no schema change. | One more service to run/patch; still no client-side/product-analytics semantics. |
| **PostHog** | Real product analytics — funnels, retention, session context — for the anon→register funnel. | New SDK + client instrumentation; PII/consent surface; cloud egress or another self-hosted stack. |
| **ClickHouse** | Only if event volume outgrows Postgres aggregation (orders of magnitude more). | Heavy for current scale; a second datastore + an ingestion pipeline to keep in sync. |

**Trigger to revisit:** adopt **Metabase** first (lowest marginal cost, same DB) when non-engineers
need self-serve charts or the dashboard question list keeps growing. Consider **PostHog** only when
funnel/retention analysis of the anon→register→credit path becomes a priority and the consent/PII
surface is designed. Consider **ClickHouse** only if `analytics_event` aggregation becomes slow on
Postgres despite indexing + retention — not before.

## Recommendation: retention & archival policy

`analytics_event` is append-only and unbounded today. Proposed policy (not yet implemented):

- **Hot retention:** keep raw rows **180 days** in Postgres. This covers the dashboard windows and
  seasonal (year-over-fishing-season is out of scope; 180d is the operational horizon) comparisons.
- **Rollups before deletion:** before pruning, materialize daily rollups (per `type`, per `source`
  for `source_miss`, per `lakeId` for `lake_resolved`) into a small summary table so long-run trends
  survive without the raw rows. This keeps the historical signal ADR-0005 cared about ("you cannot
  backfill usage history") while bounding table growth.
- **Prune job:** a scheduled delete of raw rows older than the hot window, mirroring the existing
  anon-GC pattern (`gcUnclaimedAnon`) — a plain scheduled SQL delete, no new infra.
- **PII note:** `credit_spent.payload.userId` and `conversationId` are the only identifiers stored.
  If PostHog or any external sink is later adopted, revisit consent and whether `userId` should be
  hashed at emit time. The rollup table above should store **counts only**, no identifiers.

None of the retention items are implemented in this pass — they are a proposal to schedule alongside
the external-tooling decision.
