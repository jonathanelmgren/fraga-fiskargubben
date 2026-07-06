import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  MICROSOFT_CLIENT_ID: z.string().min(1),
  MICROSOFT_CLIENT_SECRET: z.string().min(1),
  /**
   * Resend API key for transactional mail (email verification). Optional so
   * dev/CI boot without it — when unset, src/lib/email.ts logs the
   * verification URL to the console instead of sending (local testing path).
   */
  RESEND_API_KEY: z.string().min(1).optional(),
  /**
   * From-address for transactional mail. The domain must be verified in the
   * Resend dashboard (fragagubben.se).
   */
  EMAIL_FROM: z.string().default("Fiskargubben <noreply@fragagubben.se>"),
  /**
   * SLU Miljödata-MVM public ticket — import-time only (ETL).
   * To obtain: register as a web-service user at Artdatabanken UserAdmin
   * (https://accounts.artdatabanken.se), then activate the ticket under
   * "Mina sidor" in Miljödata-MVM (https://miljodata.slu.se/mvm/).
   * No approval is required; the ticket is issued immediately.
   *
   * Optional here because it is only consumed by `scripts/etl/import-mvm.ts`,
   * which reads process.env.MVM_TICKET directly and guards its own absence.
   * The runtime app must not require this or it will crash in production/CI.
   */
  MVM_TICKET: z.string().min(1).optional(),
  /**
   * Comma-separated allowlist of admin email addresses.  Gates the
   * `/admin/analytics` dashboard (ADR-0005 read-side).  Minimal by design:
   * the schema has no admin/role column yet, so authorization is an env
   * allowlist rather than a DB flag.  Optional (empty = no admins → the
   * dashboard denies everyone) so the app still boots in dev/CI without it.
   */
  ADMIN_EMAILS: z.string().optional(),
  /**
   * Signup abuse guard: max accounts per hashed client IP within a rolling
   * 30-day window. Optional — defaults to 3. Set high (e.g. 1000) in e2e/CI
   * environments where every registration comes from localhost.
   */
  SIGNUP_IP_LIMIT: z.coerce.number().int().positive().optional(),
  /**
   * Discord ops webhooks (channel settings → Integrations → Webhooks).
   * Optional — unset means notifications are silently skipped. Consumed via
   * process.env in src/lib/notify/discord.ts (keeps instrumentation.ts free
   * of the full env schema); declared here for documentation and validation.
   */
  DISCORD_WEBHOOK_ALERTS: z.string().url().optional(),
  DISCORD_WEBHOOK_SIGNUPS: z.string().url().optional(),
  /** Public Discord invite for the support channel; renders links when set. */
  NEXT_PUBLIC_DISCORD_INVITE: z.string().url().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment variables:\n${issues}`);
}

export const env = parsed.data;
