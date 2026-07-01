import "server-only";
import { env } from "@/shared/env";

/**
 * Minimal admin authorization for the ADR-0005 analytics dashboard.
 *
 * The user schema has no role/isAdmin column, so admin status is an env
 * allowlist (`ADMIN_EMAILS`, comma-separated) matched case-insensitively
 * against the Better Auth session email.  This is deliberately the smallest
 * gate that works; a proper `role` column + Better Auth admin plugin is the
 * follow-up if admin surfaces grow beyond this one read-only page.
 */
export function adminEmails(): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

/** True when `email` is on the admin allowlist. Null/empty email is never admin. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().has(email.toLowerCase());
}
