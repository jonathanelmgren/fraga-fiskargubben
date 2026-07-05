import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getSession } from "@/lib/get-session";
import { AskShell } from "./ask-shell";
import Chat from "./chat";
import { resolveChatPrefs } from "./prefs";

export const metadata: Metadata = {
  title: "Fråga Fiskargubben · Chatt",
};

/**
 * New-chat view. Auto-submits the landing hero's pending prompt (from
 * sessionStorage); once the server answers, the client swaps the URL to
 * /ask/<id> so the conversation is shareable/refreshable.
 */
export default async function AskPage() {
  const session = await getSession();
  const cookieStore = await cookies();
  const prefs = await resolveChatPrefs(cookieStore, session?.user.id ?? null);

  return (
    <AskShell>
      <Chat
        autoSubmitPending
        initialTosAccepted={prefs.tosAccepted}
        initialTosPreviouslyAccepted={prefs.tosPreviouslyAccepted}
        initialTosOnAccount={prefs.tosAcceptedOnAccount}
        initialShareLocation={prefs.shareLocation}
        initialShareLocationOnAccount={prefs.shareLocationOnAccount}
      />
    </AskShell>
  );
}
