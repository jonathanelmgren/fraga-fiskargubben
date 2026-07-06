import { ChatDrawer } from "@/components/chat-drawer";
import { FeedbackPromptDialog } from "@/components/feedback-prompt-dialog";
import { feedbackPromptDue } from "@/lib/feedback-prompt";
import { getSession } from "@/lib/get-session";
import { listConversations } from "./conversations";

/**
 * Shared shell for the /ask views: full-height (minus the h-14 site header)
 * row with the logged-in conversation drawer and the chat column.
 */
export async function AskShell({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const items = session ? await listConversations(session.user.id) : null;
  const showFeedbackPrompt = session
    ? await feedbackPromptDue(session.user.id)
    : false;

  return (
    <div className="ask-page relative flex h-[calc(100dvh-3.5rem)] overflow-hidden">
      {items && <ChatDrawer items={items} />}
      <div className="relative min-w-0 flex-1 overflow-hidden">{children}</div>
      {showFeedbackPrompt && <FeedbackPromptDialog />}
    </div>
  );
}
