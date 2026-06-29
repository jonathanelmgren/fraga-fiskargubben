# Analytics: capture structured events to Postgres now, dashboards later

We emit structured **Analytics events** to an append-only Postgres `analytics_event` table
(`type`, `lake_id?`, `payload jsonb`, `created_at`) inline from the pipeline that already does the
work — no new infrastructure, since Postgres is already the datastore. The **event taxonomy is
defined up front** (`lake_resolved`, `lake_unresolved`, `source_miss` with which source missed,
`signals_built`, `credit_spent`, `topic_refused`, `chat_limit_hit`, …) so every emit-site exists
from day one and instrumentation is never retrofitted.

External analytics (PostHog/ClickHouse), dashboards, and aggregation are a **deferred phase**,
tracked as a GitHub issue. Because the raw events are captured now, that later work is a read-side
addition — it does not require touching the pipeline again.

**Why now, this shape:** the highest-value questions ("which lakes do people ask about", "where did
we fail to resolve a lake or get data") need the events recorded from the very first real traffic —
you cannot backfill usage history. A jsonb event table is nearly free to add, durable, and directly
SQL-queryable, which is enough to answer those questions without committing to an analytics vendor
before the product is proven. The deliberate no-s: no event SDK, no external pipeline, no dashboards
in this phase.
