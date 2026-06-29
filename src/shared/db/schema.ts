import {
  bigserial,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { Signals } from "@/lib/signals/types";

/**
 * Better Auth-owned user table with two extra quota columns.
 *
 * Better Auth never sets these columns in its own INSERT (it only writes the
 * core auth fields), so both columns carry DB-level defaults (default(0) and
 * default(false)) — the DB fills them automatically on every Better-Auth-
 * triggered insert.  Drizzle .$defaultFn() alone would only run on
 * drizzle-initiated inserts; .default() writes a DEFAULT clause into the
 * CREATE TABLE / ALTER TABLE DDL, which is what we need here.
 *
 * ADR-0004: creditsUsed tracks lifetime fresh-context starts; isPaid is a
 * stub flag that lifts the 3-credit cap — real payment is a deferred phase.
 */
export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified")
    .$defaultFn(() => false)
    .notNull(),
  image: text("image"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => new Date())
    .notNull(),
  /** Lifetime count of Credits spent (new conversations with fresh data fetches). ADR-0004. */
  creditsUsed: integer("credits_used").default(0).notNull(),
  /** Stub paid flag — true lifts the 3-credit free cap. Real payment deferred. ADR-0004. */
  isPaid: boolean("is_paid").default(false).notNull(),
});

export const sessions = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const accounts = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at").$defaultFn(() => new Date()),
});

export const lakes = pgTable("lakes", {
  id: text("id").primaryKey(),
  name: text("name"),
  municipality: text("municipality").notNull(),
  county: text("county").notNull(),
  lat: doublePrecision("lat").notNull(),
  lon: doublePrecision("lon").notNull(),
  areaHa: doublePrecision("area_ha").notNull(),
});

export const analyticsEvents = pgTable("analytics_event", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  type: text("type").notNull(),
  lakeId: text("lake_id"),
  conversationId: text("conversation_id"),
  payload: jsonb("payload")
    .$type<Record<string, unknown>>()
    .default({})
    .notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const forecastCache = pgTable("forecast_cache", {
  lakeId: text("lake_id").primaryKey(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  doc: jsonb("doc").notNull(),
});

/**
 * Seeded S-HYPE modeled water temperatures per lake.
 *
 * Rows are populated by `scripts/etl/import-shype.ts` from the SMHI
 * Vattenwebb S-HYPE sub-catchment export.  Most lakes will NOT have a row
 * (the estimate-first fallback in `src/lib/water/temp.ts` handles those).
 * When a row IS present, `waterTempFor()` returns it with source "modeled",
 * confidence "high" instead of the code-computed estimate.
 */
export const waterTemp = pgTable("water_temp", {
  /** Lake id matching `lakes.id` (EU WFD water-body code). */
  lakeId: text("lake_id").primaryKey(),
  /** Modeled water temperature in °C from the S-HYPE export. */
  tempC: doublePrecision("temp_c").notNull(),
  /** Timestamp of the S-HYPE observation/forecast used for this value. */
  asOf: timestamp("as_of", { withTimezone: true }),
});

/**
 * Bathymetric depth scalars per lake.
 *
 * Rows are populated by `scripts/etl/import-depth.ts` from the SMHI
 * Vattenwebb bathymetry dataset.  Most lakes will NOT have a row (graceful
 * absence — `depthFor()` in `src/lib/water/depth.ts` returns null for those).
 * Both depth fields are nullable: the source only guarantees max depth for
 * some lakes; mean depth may be absent even when max is present.
 */
export const lakeDepth = pgTable("lake_depth", {
  /** Lake id matching `lakes.id` (EU WFD water-body code). */
  lakeId: text("lake_id").primaryKey(),
  /** Maximum lake depth in metres from the bathymetry source. */
  maxDepthM: doublePrecision("max_depth_m"),
  /** Mean lake depth in metres from the bathymetry source. */
  meanDepthM: doublePrecision("mean_depth_m"),
});

/**
 * Water colour (humic/clear) and Secchi sight depth per lake.
 *
 * Rows are populated by `scripts/etl/import-mvm.ts` from the SLU
 * Miljödata-MVM API (SampleSites / FullSamples).  The import script joins
 * MVM sample stations to lakes at import time using `stationMatchesLake` in
 * `src/lib/water/station-match.ts` (ADR-0002); the runtime lookup
 * `colourFor()` in `src/lib/water/colour.ts` is a pure table read with no
 * live MVM call and no reference to MVM_TICKET.
 *
 * `confidence` reflects the quality of the import-time join:
 *   'high' — station was ≤ 200 m from the lake centroid.
 *   'low'  — station was within the equal-area circle but > 200 m.
 */
export const waterColour = pgTable("water_colour", {
  /** Lake id matching `lakes.id` (EU WFD water-body code). */
  lakeId: text("lake_id").primaryKey(),
  /** Colour classification derived from MVM absorbans/färgtal. */
  colour: text("colour").notNull(),
  /** Secchi sight depth in metres (may be absent in source). */
  sightDepthM: doublePrecision("sight_depth_m"),
  /** Quality of the import-time station→lake join: 'high' | 'low'. */
  confidence: text("confidence").notNull(),
});

/**
 * SMHI metobs weather stations per parameter.
 *
 * A single physical station can report both air pressure and air temperature,
 * so the primary key is composite (id, parameter).
 *
 * SMHI metobs parameter ids used by import-metobs-stations.ts:
 *   - air pressure    → parameter id 9  → stored as 'pressure'
 *   - air temperature → parameter id 1  → stored as 'temp'
 */
export const metobsStations = pgTable(
  "metobs_station",
  {
    /** SMHI station id (numeric, stored as text for join-safety). */
    id: text("id").notNull(),
    /** Station display name. */
    name: text("name").notNull(),
    /** Latitude in WGS84 decimal degrees. */
    lat: doublePrecision("lat").notNull(),
    /** Longitude in WGS84 decimal degrees. */
    lon: doublePrecision("lon").notNull(),
    /** Which weather parameter this row represents: 'pressure' or 'temp'. */
    parameter: text("parameter").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id, t.parameter] })],
);

/**
 * Fish species per surveyed lake (SLU Aqua / Sötebasen test-fishing data).
 *
 * Rows are populated by `scripts/etl/import-aqua.ts` from SLU Aqua /
 * Sötebasen provfiske surveys.  The ETL joins survey stations to lakes at
 * import time using `stationMatchesLake` (ADR-0002); the runtime lookup
 * `speciesFor()` in `src/lib/water/species.ts` is a pure table read with no
 * live SLU Aqua call.
 *
 * Coverage is limited to lakes that have been surveyed — most lakes will NOT
 * have a row.  `speciesFor()` returns `null` for those (graceful absence).
 *
 * `confidence` reflects the quality of the import-time join:
 *   'high' — station was ≤ 200 m from the lake centroid.
 *   'low'  — station was within the equal-area circle but > 200 m.
 */
export const lakeSpecies = pgTable("lake_species", {
  /** Lake id matching `lakes.id` (EU WFD water-body code). */
  lakeId: text("lake_id").primaryKey(),
  /** Distinct fish species recorded for this lake (Swedish common names). */
  species: text("species").array().notNull(),
  /** Quality of the import-time station→lake join: 'high' | 'low'. */
  confidence: text("confidence"),
});

/**
 * A conversation is the billable unit (ADR-0004).
 *
 * One Credit = one new conversation = one fresh Signals fetch.
 * Context (lakeId + targetTime) is locked at creation and never changes.
 * The Signals snapshot is frozen at first prompt and stored here; follow-up
 * turns re-read from this snapshot rather than fetching fresh data.
 *
 * Anonymous conversations have userId = null and carry a claimToken in a
 * signed cookie.  On registration the conversation is claimed (userId set,
 * claimToken cleared) and counts as 1 of 3 lifetime credits for the new
 * account.  Unclaimed rows are GC'd after a TTL (ADR-0001).
 *
 * `frozen` is set true when the chat-turn limit (~20) is hit (Task 5.5).
 * It is false by default so the column is schema-ready without affecting
 * any current behaviour.
 */
export const conversations = pgTable("conversation", {
  id: text("id").primaryKey(),
  /**
   * Null for anonymous conversations (ADR-0001).
   * FK with cascade so deleting a user purges their conversations.
   */
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  /** Set for anonymous conversations; matched on registration to claim. ADR-0001. */
  claimToken: text("claim_token"),
  /** Locked Context lake for this conversation. ADR-0004. */
  lakeId: text("lake_id"),
  /** Locked Context target time for this conversation. ADR-0004. */
  targetTime: timestamp("target_time"),
  /**
   * Frozen Signals snapshot captured at first prompt. Nullable until the
   * first prompt resolves so the row can be inserted before signals are built.
   * ADR-0004.
   */
  signalsSnapshot: jsonb("signals_snapshot").$type<Signals>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastActiveAt: timestamp("last_active_at").defaultNow().notNull(),
  /**
   * Set true when the chat-turn limit is hit (Task 5.5).
   * A frozen conversation serves a plain system alert and accepts no new
   * user turns.  Not voiced as Fiskargubben — a deliberate system boundary.
   * ADR-0004.
   */
  frozen: boolean("frozen").default(false).notNull(),
});

/**
 * Individual chat turns within a conversation.
 *
 * Turn count derives from counting rows for a conversationId.
 * The soft wind-down (turn 15) and hard freeze (turn ~20) are evaluated
 * server-side by counting these rows.  ADR-0004.
 */
export const messages = pgTable("message", {
  id: text("id").primaryKey(),
  /** Parent conversation. Cascade-deleted when the conversation is removed. */
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  /** 'user' | 'assistant' */
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
