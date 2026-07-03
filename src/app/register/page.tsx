import { redirect } from "next/navigation";

/**
 * Auth moved into a dialog (rebuild spec) — the old /register route opens it
 * on the landing page (the dialog's login mode links to signup).
 */
export default function RegisterRedirect() {
  redirect("/?auth=1");
}
