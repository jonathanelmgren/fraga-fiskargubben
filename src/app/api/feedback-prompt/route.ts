/**
 * POST /api/feedback-prompt — feedback prompt funnel tracking + submission.
 *
 * Body: { action: "shown" | "dismissed" | "discord_clicked" | "submitted",
 *         message?: string }   (message required for "submitted")
 *
 * Session required (the prompt is only rendered for logged-in users).
 * "shown" stamps feedbackPromptedAt/-ChatCount on the user row — stamping at
 * show time (not page-serve time) keeps the funnel honest and prevents repeat
 * shows across tabs. Feedback text goes to the analytics event payload and to
 * the signups Discord webhook; there is no feedback table.
 * Spec: docs/superpowers/specs/2026-07-06-feedback-prompt-design.md
 */

import "server-only";

import { eq } from "drizzle-orm";
import { emit } from "@/lib/analytics/events";
import { countUserChats } from "@/lib/feedback-prompt";
import { getSession } from "@/lib/get-session";
import { notifyDiscord } from "@/lib/notify/discord";
import { db } from "@/shared/db/client";
import { users } from "@/shared/db/schema";
import { env } from "@/shared/env";
import { isSameOriginRequest } from "../ask/route";

const ACTIONS = ["shown", "dismissed", "discord_clicked", "submitted"] as const;
type Action = (typeof ACTIONS)[number];

const MAX_MESSAGE_LENGTH = 2000;

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers, env.BETTER_AUTH_URL)) {
    return Response.json({ error: "cross-origin" }, { status: 403 });
  }

  const session = await getSession();
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  const { action, message } = body as { action?: unknown; message?: unknown };
  if (
    typeof action !== "string" ||
    !(ACTIONS as readonly string[]).includes(action)
  ) {
    return Response.json({ error: "invalid action" }, { status: 400 });
  }

  const userId = session.user.id;
  const chatCount = await countUserChats(userId);

  switch (action as Action) {
    case "submitted": {
      const text = typeof message === "string" ? message.trim() : "";
      if (text.length === 0 || text.length > MAX_MESSAGE_LENGTH) {
        return Response.json({ error: "invalid message" }, { status: 400 });
      }
      // Awaited so the analytics row (source of truth for feedback text) is
      // written before the response is returned. emit is non-fatal internally.
      await emit({
        type: "feedback_prompt_submitted",
        payload: { userId, chatCount, message: text },
      });
      void notifyDiscord(
        "signups",
        `📝 Feedback från ${session.user.name} (${session.user.email}):\n> ${text}`,
      );
      break;
    }
    case "shown": {
      await db
        .update(users)
        .set({
          feedbackPromptedAt: new Date(),
          feedbackPromptedChatCount: chatCount,
        })
        .where(eq(users.id, userId));
      void emit({
        type: "feedback_prompt_shown",
        payload: { userId, chatCount },
      });
      break;
    }
    case "dismissed":
    case "discord_clicked": {
      void emit({
        type:
          action === "discord_clicked"
            ? "feedback_prompt_discord_clicked"
            : "feedback_prompt_dismissed",
        payload: { userId, chatCount },
      });
      break;
    }
  }

  return Response.json({ ok: true });
}
