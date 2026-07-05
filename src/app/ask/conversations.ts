/**
 * Server-side data loaders for the /ask views: the logged-in conversation
 * drawer and the persisted-conversation page.
 */
import "server-only";

import { asc, desc, eq } from "drizzle-orm";
import type { DrawerItem } from "@/components/chat-drawer";
import { toBadges } from "@/lib/chat/ask-handler";
import type { Signals } from "@/lib/signals/types";
import { db } from "@/shared/db/client";
import { conversations, messages } from "@/shared/db/schema";

const DRAWER_LIMIT = 30;

const dateFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  day: "numeric",
  month: "short",
});

function titleOf(snapshot: Signals | null, status: string): string {
  if (snapshot?.bareLakeName) return snapshot.bareLakeName;
  if (snapshot?.areaOnly) return snapshot.askedLakeName ?? snapshot.lake;
  if (snapshot?.lake) return snapshot.lake;
  return status === "lake_pending" ? "Ny fråga" : "Chatt";
}

export async function listConversations(userId: string): Promise<DrawerItem[]> {
  const rows = await db
    .select({
      id: conversations.id,
      status: conversations.status,
      snapshot: conversations.signalsSnapshot,
      lastActiveAt: conversations.lastActiveAt,
    })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.lastActiveAt))
    .limit(DRAWER_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    title: titleOf(row.snapshot ?? null, row.status),
    dateLabel: dateFmt.format(row.lastActiveAt),
    status: row.status,
  }));
}

export type ConversationView = {
  id: string;
  frozen: boolean;
  badges: ReturnType<typeof toBadges> | null;
  messages: Array<{ role: "user" | "assistant"; text: string; id: string }>;
};

/**
 * Load a conversation for the /ask/[id] page, enforcing the same ownership
 * rule as the API (C1): logged-in owner OR anon with a matching claim token.
 * Returns null when missing or foreign — the page renders notFound().
 */
export async function loadConversationView(
  id: string,
  caller: { userId: string | null; claimToken: string | null },
): Promise<ConversationView | null> {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const owns = caller.userId
    ? row.userId === caller.userId
    : row.userId === null &&
      caller.claimToken !== null &&
      row.claimToken === caller.claimToken;
  if (!owns) return null;

  const messageRows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
    })
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));

  const snapshot = row.signalsSnapshot ?? null;
  const badges =
    snapshot && row.status !== "lake_pending"
      ? toBadges(snapshot, row.status as "resolved" | "unresolved_area")
      : null;

  return {
    id: row.id,
    frozen: row.frozen,
    badges,
    messages: messageRows.map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      text: m.content,
    })),
  };
}
