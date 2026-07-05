import { redirect } from "next/navigation";

/**
 * Auth moved into a dialog (rebuild spec) — the old /login route opens it on
 * the landing page instead.
 */
export default function LoginRedirect() {
  redirect("/?auth=1");
}
