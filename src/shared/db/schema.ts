import {
  bigserial,
  boolean,
  doublePrecision,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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
