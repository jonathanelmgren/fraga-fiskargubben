import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL must be set to run drizzle-kit.");
}

export default defineConfig({
  out: "./drizzle",
  schema: "./src/shared/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url },
  verbose: true,
  strict: true,
});
