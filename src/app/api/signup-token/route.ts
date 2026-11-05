import { issueSignupToken } from "@/lib/auth/signup-token";

/** Every response carries the current time, so it must never be prerendered. */
export const dynamic = "force-dynamic";

/** Issues the token the signup form must send (see lib/auth/signup-token.ts). */
export function GET() {
  return Response.json(
    { token: issueSignupToken() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
