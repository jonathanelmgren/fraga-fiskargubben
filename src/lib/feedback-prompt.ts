/**
 * Feedback prompt eligibility (spec 2026-07-06-feedback-prompt-design.md).
 *
 * Logged-in users only. First prompt at the 3rd chat; each repeat needs 5 more
 * chats than at the last prompt AND a 30-day gap (so 3rd, 8th, 13th, … at
 * most every 30 days). State lives on the user row and is stamped at SHOW
 * time by /api/feedback-prompt, not at page-serve time.
 */

import "server-only";

import { count, eq } from "drizzle-orm";
import { db } from "@/shared/db/client";
import { conversations, users } from "@/shared/db/schema";

export const FEEDBACK_FIRST_PROMPT_CHATS = 3;
export const FEEDBACK_REPEAT_CHAT_GAP = 5;
export const FEEDBACK_REPEAT_DAY_GAP = 30;

const DAY_MS = 86_400_000;

export function isFeedbackPromptDue(input: {
  chatCount: number;
  promptedAt: Date | null;
  promptedChatCount: number;
  now?: Date;
}): boolean {
  const { chatCount, promptedAt, promptedChatCount } = input;
  if (promptedAt === null) {
    return chatCount >= FEEDBACK_FIRST_PROMPT_CHATS;
  }
  const now = input.now ?? new Date();
  const daysSince = (now.getTime() - promptedAt.getTime()) / DAY_MS;
  return (
    chatCount >= promptedChatCount + FEEDBACK_REPEAT_CHAT_GAP &&
    daysSince > FEEDBACK_REPEAT_DAY_GAP
  );
}

/** Total conversations for the user — frozen included (a frozen chat was still a chat). */
export async function countUserChats(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(conversations)
    .where(eq(conversations.userId, userId));
  return row?.n ?? 0;
}

/** Server-side gate used by AskShell. */
export async function feedbackPromptDue(userId: string): Promise<boolean> {
  const [u] = await db
    .select({
      promptedAt: users.feedbackPromptedAt,
      promptedChatCount: users.feedbackPromptedChatCount,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return false;
  const chatCount = await countUserChats(userId);
  return isFeedbackPromptDue({
    chatCount,
    promptedAt: u.promptedAt,
    promptedChatCount: u.promptedChatCount,
  });
}
