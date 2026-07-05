import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { verifyClaimToken } from "@/lib/chat/claim-cookie";
import { getSession } from "@/lib/get-session";
import { AskShell } from "../ask-shell";
import Chat from "../chat";
import { loadConversationView } from "../conversations";
import { resolveChatPrefs } from "../prefs";

export const metadata: Metadata = {
  title: "Fråga Fiskargubben · Chatt",
};

const CLAIM_TOKEN_COOKIE = "fiska_claim";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Persisted-conversation view: server-loads the message history + signal
 * badges, with the same ownership rule as the API (owner or matching anon
 * claim cookie). Unknown/foreign ids 404 without revealing existence.
 */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const session = await getSession();
  const cookieStore = await cookies();
  const claimToken = verifyClaimToken(
    cookieStore.get(CLAIM_TOKEN_COOKIE)?.value,
  );

  const view = await loadConversationView(id, {
    userId: session?.user.id ?? null,
    claimToken,
  });
  if (!view) notFound();

  const prefs = await resolveChatPrefs(cookieStore, session?.user.id ?? null);

  return (
    <AskShell>
      <Chat
        conversationId={view.id}
        initialMessages={view.messages.map((m) => ({
          role: m.role,
          text: m.text,
          id: m.id,
        }))}
        initialBadges={view.badges}
        initialFrozen={view.frozen}
        initialTosAccepted={prefs.tosAccepted}
        initialTosPreviouslyAccepted={prefs.tosPreviouslyAccepted}
        initialTosOnAccount={prefs.tosAcceptedOnAccount}
        initialShareLocation={prefs.shareLocation}
        initialShareLocationOnAccount={prefs.shareLocationOnAccount}
      />
    </AskShell>
  );
}
