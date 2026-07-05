/**
 * Client-preference cookies, readable server-side so the /ask and landing
 * pages can render the correct geo/terms state in the initial HTML (no
 * hydration shift). Written by client code via document.cookie; read on the
 * server via next/headers cookies() using the exported names.
 *
 * Not HttpOnly by design — these are UI preferences, not secrets, and the
 * client must be able to write them without a round-trip. Logged-in users
 * additionally get the values mirrored onto their account (POST
 * /api/preferences) so preferences survive a new browser.
 */

/** "1" | "0" — the "Använd min plats" toggle. */
export const SHARE_LOCATION_COOKIE = "fg_share_location";

/** Accepted TOS_VERSION as a decimal string. */
export const TOS_COOKIE = "fg_tos_v";

const ONE_YEAR_S = 60 * 60 * 24 * 365;

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function writeCookie(name: string, value: string): void {
  if (typeof document === "undefined") return;
  // biome-ignore lint/suspicious/noDocumentCookie: the async CookieStore API
  // is Chromium-only; these are simple, non-sensitive preference cookies.
  document.cookie = `${name}=${value}; path=/; max-age=${ONE_YEAR_S}; SameSite=Lax`;
}

export function readShareLocationCookie(): boolean | undefined {
  const raw = readCookie(SHARE_LOCATION_COOKIE);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return undefined;
}

export function writeShareLocationCookie(on: boolean): void {
  writeCookie(SHARE_LOCATION_COOKIE, on ? "1" : "0");
}

export function readTosCookieVersion(): number | null {
  return parseTosVersion(readCookie(TOS_COOKIE));
}

export function writeTosCookie(version: number): void {
  writeCookie(TOS_COOKIE, String(version));
}

/** Shared parser — also used server-side on the raw cookie value. */
export function parseTosVersion(raw: string | undefined): number | null {
  if (!raw) return null;
  const version = Number.parseInt(raw, 10);
  return Number.isFinite(version) && version > 0 ? version : null;
}
