# Task 5.1 Report: conversation + message + credit schema

## Status: DONE — commit dc2cbb5

---

## Schema additions

### 1. `conversations` table (pgTable "conversation")
- `id` text PK
- `userId` text — nullable (anon = null per ADR-0001), FK to `user.id` ON DELETE CASCADE
- `claimToken` text — nullable; set for anon conversations, matched on registration
- `lakeId` text — locked Context lake (ADR-0004)
- `targetTime` timestamp — locked Context target time (ADR-0004)
- `signalsSnapshot` jsonb.$type<Signals>() — nullable; frozen at first prompt
- `createdAt` timestamp DEFAULT now() NOT NULL
- `lastActiveAt` timestamp DEFAULT now() NOT NULL
- `frozen` boolean DEFAULT false NOT NULL — set true at chat-turn limit (Task 5.5 writes this)

### 2. `messages` table (pgTable "message")
- `id` text PK
- `conversationId` text NOT NULL, FK to `conversation.id` ON DELETE CASCADE
- `role` text NOT NULL — 'user' | 'assistant'
- `content` text NOT NULL
- `createdAt` timestamp DEFAULT now() NOT NULL

Turn count derived by counting rows per `conversationId`.

### 3. Credit columns on `user` table
- `creditsUsed` integer DEFAULT 0 NOT NULL
- `isPaid` boolean DEFAULT false NOT NULL

---

## user table vs. userQuota decision

**Decision: extend the existing `user` table.**

Rationale:
- Better Auth's drizzle adapter issues INSERT statements that only name the columns it knows about (id, name, email, emailVerified, image, createdAt, updatedAt). Any column not mentioned in the INSERT falls back to the DB-level DEFAULT clause.
- Both new columns use `.default(0).notNull()` and `.default(false).notNull()` — these produce `DEFAULT 0` and `DEFAULT false` in the ALTER TABLE DDL, so Postgres fills them automatically on Better-Auth-triggered inserts. A `.$defaultFn()` alone would only run on Drizzle-initiated inserts and would NOT cover Better Auth's raw inserts.
- A separate `userQuota` table would add a JOIN on every quota check and require an insert trigger or application hook to create the row on registration — more moving parts for no safety gain.
- Better Auth explicitly documents that extra columns with DB defaults are safe; the adapter does not fail on unknown columns.
- This is consistent with the project's existing pattern: the `user` table is the single source of truth for everything user-scoped.

---

## Migration

- File: `drizzle/0010_natural_ezekiel.sql`
- Journal idx: 10 (previous was 9, `0009_talented_bug`). Consistent.
- Content: `CREATE TABLE "conversation"`, `CREATE TABLE "message"`, two `ALTER TABLE "user" ADD COLUMN` statements, two FK constraints. Verified manually — all expected columns, types, and defaults are present.

---

## Testing

No unit test added. Rationale: this task adds only schema definitions (Drizzle table objects and SQL DDL). There is no runtime logic to exercise. A test that imports the table objects and asserts a property exists would be tautological — it would only confirm TypeScript compiled, which `ts:check` already verifies more rigorously.

Verification performed:
1. `pnpm ts:check` — clean, zero errors.
2. `pnpm db:generate` — produced `0010_natural_ezekiel.sql` with all expected tables and columns.
3. SQL reviewed manually — confirmed nullable userId, FK cascades, DB defaults on frozen/creditsUsed/isPaid.

---

## Biome result

- `biome check src/shared/db/schema.ts` — **clean** (1 file, 0 issues).
- `pnpm biome check .` (full project) surfaces 2 pre-existing lint errors in `src/lib/analytics/events.test.ts` and `src/lib/water/temp.test.ts` (not our files), plus trailing-newline drift in drizzle-generated JSON meta files.
- The pre-commit hook (`lefthook.yml`) runs `biome check --write --files-ignore-unknown=true` on staged files only with `stage_fixed: true`. It auto-fixed the trailing-newline drift in `drizzle/meta/0010_snapshot.json` and `drizzle/meta/_journal.json` and re-staged them. All hooks passed on commit.

---

## Files changed

- `src/shared/db/schema.ts` — added `integer` + `Signals` imports; `creditsUsed`/`isPaid` columns on `users`; `conversations` table; `messages` table
- `drizzle/0010_natural_ezekiel.sql` — new migration (created by drizzle-kit)
- `drizzle/meta/0010_snapshot.json` — new snapshot (created by drizzle-kit)
- `drizzle/meta/_journal.json` — updated with idx 10 entry (updated by drizzle-kit)

---

## Self-review

- userId is correctly nullable (no `.notNull()`) — anon conversations have null userId per ADR-0001.
- signalsSnapshot is nullable — allows the row to exist before signals resolve.
- frozen column is included now so Task 5.5 can write it without a schema migration.
- DB-level defaults on creditsUsed/isPaid protect against Better Auth's user inserts.
- No runtime logic included — YAGNI. Extractor, quota gate, routes are 5.2–5.7.

## Concerns

None. Schema is straightforward. The only non-trivial decision (user vs. userQuota) is documented and rationale is solid.
