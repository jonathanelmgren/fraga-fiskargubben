/**
 * Account-level chat preferences for the /ask views. Anon users keep the
 * same preferences in localStorage; the chat client transfers them to the
 * account (POST /api/preferences) on the first logged-in visit.
 */
import "server-only";

import { eq } from "drizzle-orm";
import {
  parseTosVersion,
  SHARE_LOCATION_COOKIE,
  TOS_COOKIE,
} from "@/lib/prefs-cookies";
import { TOS_VERSION } from "@/lib/tos-version";
import { db } from "@/shared/db/client";
import { users } from "@/shared/db/schema";

export type UserPrefs = {
  shareLocation: boolean;
  /** Accepted the CURRENT terms version. */
  tosAccepted: boolean;
  /** Accepted SOME version (drives "updated terms" vs first-time gate copy). */
  tosPreviouslyAccepted: boolean;
};

export async function getUserPrefs(userId: string): Promise<UserPrefs> {
  const rows = await db
    .select({
      shareLocation: users.shareLocation,
      tosAcceptedVersion: users.tosAcceptedVersion,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  const version = row?.tosAcceptedVersion ?? null;
  return {
    shareLocation: row?.shareLocation ?? false,
    tosAccepted: version !== null && version >= TOS_VERSION,
    tosPreviouslyAccepted: version !== null,
  };
}

type CookieReader = { get(name: string): { value: string } | undefined };

export type ResolvedChatPrefs = UserPrefs & {
  /** Whether the CURRENT acceptance came from the account (vs cookie only). */
  tosAcceptedOnAccount: boolean;
  /** Account-side value only — drives the cookie→account transfer. */
  shareLocationOnAccount: boolean;
};

/**
 * Combine account prefs (logged in) with the preference cookies so the /ask
 * pages can render geo toggle and terms gate correctly in the initial HTML.
 * The cookie wins for shareLocation (most recent explicit choice on THIS
 * browser); for terms, acceptance from either store counts.
 */
export async function resolveChatPrefs(
  cookieStore: CookieReader,
  userId: string | null,
): Promise<ResolvedChatPrefs> {
  const account = userId ? await getUserPrefs(userId) : null;

  const cookieShare = cookieStore.get(SHARE_LOCATION_COOKIE)?.value;
  const shareLocation =
    cookieShare === "1"
      ? true
      : cookieShare === "0"
        ? false
        : (account?.shareLocation ?? false);

  const cookieTosVersion = parseTosVersion(cookieStore.get(TOS_COOKIE)?.value);
  const cookieTosCurrent =
    cookieTosVersion !== null && cookieTosVersion >= TOS_VERSION;

  return {
    shareLocation,
    tosAccepted: (account?.tosAccepted ?? false) || cookieTosCurrent,
    tosPreviouslyAccepted:
      (account?.tosPreviouslyAccepted ?? false) || cookieTosVersion !== null,
    tosAcceptedOnAccount: account?.tosAccepted ?? false,
    shareLocationOnAccount: account?.shareLocation ?? false,
  };
}
