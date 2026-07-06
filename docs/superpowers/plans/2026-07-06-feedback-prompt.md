# Feedback Prompt Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show logged-in users with ≥3 chats a dialog promoting Discord + an inline quick-feedback form, with the full funnel (shown/dismissed/discord-click/submit) tracked in the server `analytics_event` table.

**Architecture:** Eligibility is computed server-side in `AskShell` (shared by `/ask` and `/ask/[id]`) from two new `user` columns + a conversation count. A client dialog posts every funnel action to one API route, which stamps the user row on `shown`, emits analytics events, and forwards submitted feedback to the signups Discord webhook. A funnel query aggregates the four event types.

**Tech Stack:** Next.js (App Router — **this repo's Next.js differs from training data; read `node_modules/next/dist/docs/` before deviating from the repo patterns shown below**), Drizzle ORM + drizzle-kit migrations, Vitest (jsdom) + @testing-library/react, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-06-feedback-prompt-design.md`

## Global Constraints

- Logged-in users only; first prompt at chat count ≥ 3; repeat prompt when chat count ≥ last-prompt-count + 5 **and** > 30 days since last prompt.
- All user-facing copy is Swedish, hardcoded inline (no i18n library).
- Analytics: server `analyticsEvents` only — **no Plausible calls**. Event types: `feedback_prompt_shown`, `feedback_prompt_dismissed`, `feedback_prompt_discord_clicked`, `feedback_prompt_submitted`. Payloads all include `{ userId, chatCount }`; submitted adds `{ message }`.
- Feedback text goes to event payload + `notifyDiscord("signups", …)`. No new feedback table.
- Package manager: `pnpm`. Tests: `pnpm test` (vitest run).
- Pre-commit hook has a biome version drift issue — commit with `git commit --no-verify`.
- No new dependencies.

---

### Task 1: Schema columns + migration

**Files:**
- Modify: `src/shared/db/schema.ts` (users table, after `tosAcceptedVersion` around line 70)
- Create (generated): `drizzle/0023_*.sql`

**Interfaces:**
- Produces: `users.feedbackPromptedAt: timestamp | null`, `users.feedbackPromptedChatCount: integer` (default 0, not null) — consumed by Tasks 2 and 3.

- [ ] **Step 1: Add columns to the users table**

In `src/shared/db/schema.ts`, inside `export const users = pgTable("user", { ... })`, after the `tosAcceptedVersion` field:

```typescript
  /**
   * Feedback prompt gate (spec 2026-07-06-feedback-prompt-design.md): when the
   * prompt was last SHOWN (stamped by /api/feedback-prompt action=shown), and
   * the user's conversation count at that moment. Null promptedAt = never
   * prompted. Next prompt requires count >= promptedChatCount + 5 AND > 30
   * days since promptedAt.
   */
  feedbackPromptedAt: timestamp("feedback_prompted_at"),
  feedbackPromptedChatCount: integer("feedback_prompted_chat_count")
    .default(0)
    .notNull(),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/0023_<name>.sql` containing:

```sql
ALTER TABLE "user" ADD COLUMN "feedback_prompted_at" timestamp;
ALTER TABLE "user" ADD COLUMN "feedback_prompted_chat_count" integer DEFAULT 0 NOT NULL;
```

Inspect the file; it must contain ONLY these two ALTERs (if drizzle-kit drifts in unrelated changes, stop and report).

- [ ] **Step 3: Apply locally**

Run: `pnpm db:migrate`
Expected: exits 0. (Prod migration happens via the usual tunnel workflow at deploy time — out of scope here.)

- [ ] **Step 4: Commit**

```bash
git add src/shared/db/schema.ts drizzle/
git commit --no-verify -m "feat(db): add feedback prompt gate columns to user"
```

---

### Task 2: Eligibility module

**Files:**
- Create: `src/lib/feedback-prompt.ts`
- Test: `src/lib/feedback-prompt.test.ts`

**Interfaces:**
- Consumes: `users.feedbackPromptedAt`, `users.feedbackPromptedChatCount` (Task 1).
- Produces:
  - `isFeedbackPromptDue(input: { chatCount: number; promptedAt: Date | null; promptedChatCount: number; now?: Date }): boolean` (pure)
  - `countUserChats(userId: string): Promise<number>` (used by Task 3 route)
  - `feedbackPromptDue(userId: string): Promise<boolean>` (used by Task 4 AskShell)

- [ ] **Step 1: Write the failing test**

Create `src/lib/feedback-prompt.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/db/client", () => ({ db: {} }));

import { isFeedbackPromptDue } from "./feedback-prompt";

const DAY = 86_400_000;
const now = new Date("2026-07-06T12:00:00Z");

describe("isFeedbackPromptDue", () => {
  it("is not due before the 3rd chat when never prompted", () => {
    expect(
      isFeedbackPromptDue({ chatCount: 2, promptedAt: null, promptedChatCount: 0, now }),
    ).toBe(false);
  });

  it("is due at the 3rd chat when never prompted", () => {
    expect(
      isFeedbackPromptDue({ chatCount: 3, promptedAt: null, promptedChatCount: 0, now }),
    ).toBe(true);
  });

  it("is not due at +4 chats even after 31 days", () => {
    expect(
      isFeedbackPromptDue({
        chatCount: 7,
        promptedAt: new Date(now.getTime() - 31 * DAY),
        promptedChatCount: 3,
        now,
      }),
    ).toBe(false);
  });

  it("is not due at +5 chats when only 29 days passed", () => {
    expect(
      isFeedbackPromptDue({
        chatCount: 8,
        promptedAt: new Date(now.getTime() - 29 * DAY),
        promptedChatCount: 3,
        now,
      }),
    ).toBe(false);
  });

  it("is due at +5 chats after 31 days", () => {
    expect(
      isFeedbackPromptDue({
        chatCount: 8,
        promptedAt: new Date(now.getTime() - 31 * DAY),
        promptedChatCount: 3,
        now,
      }),
    ).toBe(true);
  });

  it("first prompt does not fire early even with high count until stamped", () => {
    // A user with 100 chats who was never prompted gets the FIRST prompt.
    expect(
      isFeedbackPromptDue({ chatCount: 100, promptedAt: null, promptedChatCount: 0, now }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/feedback-prompt.test.ts`
Expected: FAIL — cannot resolve `./feedback-prompt`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/feedback-prompt.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/feedback-prompt.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/feedback-prompt.ts src/lib/feedback-prompt.test.ts
git commit --no-verify -m "feat: add feedback prompt eligibility logic"
```

---

### Task 3: Event types + API route

**Files:**
- Modify: `src/lib/analytics/events.ts` (extend `AnalyticsEventType` union, end of union around line 62)
- Create: `src/app/api/feedback-prompt/route.ts`
- Test: `src/app/api/feedback-prompt/route.test.ts`

**Interfaces:**
- Consumes: `countUserChats(userId)` (Task 2), `emit(event)` from `@/lib/analytics/events`, `notifyDiscord("signups", content)` from `@/lib/notify/discord`, `isSameOriginRequest` re-exported from `../ask/route`, `getSession()` from `@/lib/get-session`.
- Produces: `POST /api/feedback-prompt` accepting `{ action: "shown" | "dismissed" | "discord_clicked" | "submitted", message?: string }` → `{ ok: true }`. Consumed by Task 4 client dialog. New `AnalyticsEventType` members consumed by Task 5 query.

- [ ] **Step 1: Add the four event types**

In `src/lib/analytics/events.ts`, extend the union — change the last line `| "llm_usage";` to:

```typescript
  | "llm_usage"
  // Feedback prompt funnel (spec 2026-07-06-feedback-prompt-design.md). All
  // payloads { userId, chatCount }; submitted adds { message } — the feedback
  // text lives HERE (no dedicated table). dismissed = closed with no prior
  // discord click or submit.
  | "feedback_prompt_shown"
  | "feedback_prompt_dismissed"
  | "feedback_prompt_discord_clicked"
  | "feedback_prompt_submitted";
```

- [ ] **Step 2: Write the failing route test**

Create `src/app/api/feedback-prompt/route.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return {
    update,
    set,
    where,
    getSession: vi.fn(),
    emit: vi.fn().mockResolvedValue(undefined),
    notifyDiscord: vi.fn().mockResolvedValue(undefined),
    countUserChats: vi.fn().mockResolvedValue(4),
    isSameOriginRequest: vi.fn().mockReturnValue(true),
  };
});

vi.mock("@/shared/db/client", () => ({ db: { update: h.update } }));
vi.mock("@/shared/env", () => ({ env: { BETTER_AUTH_URL: "http://localhost:3000" } }));
vi.mock("@/lib/get-session", () => ({ getSession: h.getSession }));
vi.mock("@/lib/analytics/events", () => ({ emit: h.emit }));
vi.mock("@/lib/notify/discord", () => ({ notifyDiscord: h.notifyDiscord }));
vi.mock("@/lib/feedback-prompt", () => ({ countUserChats: h.countUserChats }));
vi.mock("@/app/api/ask/route", () => ({ isSameOriginRequest: h.isSameOriginRequest }));

import { POST } from "./route";

function req(body: unknown): Request {
  return new Request("http://localhost:3000/api/feedback-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const session = {
  user: { id: "u1", name: "Anna", email: "anna@example.com" },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getSession.mockResolvedValue(session);
  h.countUserChats.mockResolvedValue(4);
  h.isSameOriginRequest.mockReturnValue(true);
  h.set.mockReturnValue({ where: h.where });
  h.update.mockReturnValue({ set: h.set });
});

describe("POST /api/feedback-prompt", () => {
  it("rejects unauthenticated requests", async () => {
    h.getSession.mockResolvedValue(null);
    const res = await POST(req({ action: "shown" }));
    expect(res.status).toBe(401);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("rejects unknown actions", async () => {
    const res = await POST(req({ action: "nonsense" }));
    expect(res.status).toBe(400);
  });

  it("shown stamps the user row and emits", async () => {
    const res = await POST(req({ action: "shown" }));
    expect(res.status).toBe(200);
    expect(h.set).toHaveBeenCalledWith(
      expect.objectContaining({
        feedbackPromptedAt: expect.any(Date),
        feedbackPromptedChatCount: 4,
      }),
    );
    expect(h.emit).toHaveBeenCalledWith({
      type: "feedback_prompt_shown",
      payload: { userId: "u1", chatCount: 4 },
    });
  });

  it("dismissed emits without touching the user row", async () => {
    const res = await POST(req({ action: "dismissed" }));
    expect(res.status).toBe(200);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.emit).toHaveBeenCalledWith({
      type: "feedback_prompt_dismissed",
      payload: { userId: "u1", chatCount: 4 },
    });
  });

  it("discord_clicked emits its own event type", async () => {
    await POST(req({ action: "discord_clicked" }));
    expect(h.emit).toHaveBeenCalledWith({
      type: "feedback_prompt_discord_clicked",
      payload: { userId: "u1", chatCount: 4 },
    });
  });

  it("submitted requires a non-empty message", async () => {
    const res = await POST(req({ action: "submitted", message: "   " }));
    expect(res.status).toBe(400);
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.notifyDiscord).not.toHaveBeenCalled();
  });

  it("submitted caps message length at 2000", async () => {
    const res = await POST(req({ action: "submitted", message: "x".repeat(2001) }));
    expect(res.status).toBe(400);
  });

  it("submitted emits with message and notifies Discord signups channel", async () => {
    const res = await POST(req({ action: "submitted", message: " Bra app! " }));
    expect(res.status).toBe(200);
    expect(h.emit).toHaveBeenCalledWith({
      type: "feedback_prompt_submitted",
      payload: { userId: "u1", chatCount: 4, message: "Bra app!" },
    });
    expect(h.notifyDiscord).toHaveBeenCalledWith(
      "signups",
      expect.stringContaining("Bra app!"),
    );
    expect(h.update).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests", async () => {
    h.isSameOriginRequest.mockReturnValue(false);
    const res = await POST(req({ action: "shown" }));
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/feedback-prompt/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 4: Write the route**

Create `src/app/api/feedback-prompt/route.ts`:

```typescript
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
      void emit({
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/app/api/feedback-prompt/route.test.ts`
Expected: 9 passed. Also run `pnpm vitest run src/lib/analytics/events.test.ts` — still green (union extension is additive).

- [ ] **Step 6: Commit**

```bash
git add src/lib/analytics/events.ts src/app/api/feedback-prompt/
git commit --no-verify -m "feat: add feedback prompt API route and event types"
```

---

### Task 4: Dialog component + AskShell integration

**Files:**
- Create: `src/components/feedback-prompt-dialog.tsx`
- Modify: `src/app/ask/ask-shell.tsx`
- Test: `src/components/feedback-prompt-dialog.test.tsx`

**Interfaces:**
- Consumes: `POST /api/feedback-prompt` (Task 3), `feedbackPromptDue(userId)` (Task 2), `NEXT_PUBLIC_DISCORD_INVITE`.
- Produces: `<FeedbackPromptDialog />` (no props) — rendered by AskShell only when due.

- [ ] **Step 1: Write the failing component test**

Create `src/components/feedback-prompt-dialog.test.tsx`:

```tsx
/**
 * feedback-prompt-dialog.test.tsx — funnel-event wiring of the feedback dialog.
 * Same conventions as auth-dialog.test.tsx: jsdom, no jest-dom, plain expect().
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedbackPromptDialog } from "./feedback-prompt-dialog";

const fetchMock = vi.fn();

function sentActions(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map(([, init]) =>
    JSON.parse((init as RequestInit).body as string),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXT_PUBLIC_DISCORD_INVITE", "https://discord.gg/test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("FeedbackPromptDialog", () => {
  it("posts shown exactly once on mount", async () => {
    render(<FeedbackPromptDialog />);
    await waitFor(() =>
      expect(sentActions()).toEqual([{ action: "shown" }]),
    );
  });

  it("posts dismissed when closed without any action", async () => {
    render(<FeedbackPromptDialog />);
    fireEvent.click(screen.getAllByLabelText("Stäng")[1]); // X button (index 0 is backdrop)
    await waitFor(() =>
      expect(sentActions()).toEqual([{ action: "shown" }, { action: "dismissed" }]),
    );
    expect(screen.queryByRole("dialog")).toBe(null);
  });

  it("posts submitted with the message and shows thanks, no dismissed", async () => {
    render(<FeedbackPromptDialog />);
    fireEvent.change(screen.getByPlaceholderText(/Vad funkar bra/), {
      target: { value: "Bra app!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Skicka" }));
    await waitFor(() =>
      expect(screen.getByText(/Tack för din feedback/)).toBeTruthy(),
    );
    expect(sentActions()).toEqual([
      { action: "shown" },
      { action: "submitted", message: "Bra app!" },
    ]);
  });

  it("does not submit an empty message", async () => {
    render(<FeedbackPromptDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Skicka" }));
    await waitFor(() => expect(sentActions()).toEqual([{ action: "shown" }]));
  });

  it("posts discord_clicked on the invite link; closing after is not dismissed", async () => {
    render(<FeedbackPromptDialog />);
    fireEvent.click(screen.getByRole("link", { name: /Discord/ }));
    fireEvent.click(screen.getAllByLabelText("Stäng")[1]);
    await waitFor(() =>
      expect(sentActions()).toEqual([
        { action: "shown" },
        { action: "discord_clicked" },
      ]),
    );
  });

  it("keeps the form and shows an error when submit fails", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return body.action === "submitted" ? { ok: false } : { ok: true };
    });
    render(<FeedbackPromptDialog />);
    fireEvent.change(screen.getByPlaceholderText(/Vad funkar bra/), {
      target: { value: "Bra app!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Skicka" }));
    await waitFor(() =>
      expect(screen.getByText(/gick inte att skicka/i)).toBeTruthy(),
    );
    expect(
      (screen.getByPlaceholderText(/Vad funkar bra/) as HTMLTextAreaElement)
        .value,
    ).toBe("Bra app!");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/feedback-prompt-dialog.test.tsx`
Expected: FAIL — cannot resolve `./feedback-prompt-dialog`.

- [ ] **Step 3: Write the component**

Create `src/components/feedback-prompt-dialog.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type FunnelAction = "shown" | "dismissed" | "discord_clicked" | "submitted";

function send(action: FunnelAction, message?: string): Promise<{ ok: boolean }> {
  return fetch("/api/feedback-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message === undefined ? { action } : { action, message }),
    // Survives the tab navigating away (e.g. straight to Discord).
    keepalive: true,
  });
}

/**
 * Feedback prompt (spec 2026-07-06-feedback-prompt-design.md): rendered by
 * AskShell only when the server-side gate says it is due, so mounting = the
 * prompt IS shown; the mount effect stamps that on the server. Discord first,
 * quick-feedback textarea second. "dismissed" is only emitted when the user
 * closes without clicking Discord or submitting.
 */
export function FeedbackPromptDialog() {
  const [open, setOpen] = useState(true);
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<"form" | "sending" | "thanks">("form");
  const [error, setError] = useState(false);
  // True once the user clicked Discord or submitted — suppresses "dismissed".
  const actedRef = useRef(false);
  const shownSentRef = useRef(false);

  // NEXT_PUBLIC_* is inlined at build time, so the client can read it directly.
  const discordInvite = process.env.NEXT_PUBLIC_DISCORD_INVITE;

  useEffect(() => {
    if (shownSentRef.current) return; // StrictMode double-invoke guard
    shownSentRef.current = true;
    send("shown").catch(() => {});
  }, []);

  const close = useCallback(() => {
    if (!actedRef.current) send("dismissed").catch(() => {});
    setOpen(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  if (!open) return null;

  const handleDiscordClick = () => {
    actedRef.current = true;
    send("discord_clicked").catch(() => {});
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = message.trim();
    if (!text || phase === "sending") return;
    setPhase("sending");
    setError(false);
    try {
      const res = await send("submitted", text);
      if (!res.ok) throw new Error("submit failed");
      actedRef.current = true;
      setPhase("thanks");
    } catch {
      setPhase("form");
      setError(true);
    }
  };

  // Portaled to <body>: the site header's backdrop-filter makes it a
  // containing block for fixed descendants (same pattern as SupportDialog).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Feedback"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Stäng"
        onClick={close}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-[2px] cursor-default"
        tabIndex={-1}
      />

      <div className="relative w-full max-w-sm rounded-xl border border-border bg-card p-7 shadow-xl">
        <button
          type="button"
          onClick={close}
          aria-label="Stäng"
          className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        </button>

        {phase === "thanks" ? (
          <p className="py-6 text-center text-base font-medium text-card-foreground">
            Tack för din feedback! 🎣
          </p>
        ) : (
          <>
            <h2 className="mb-1 text-xl font-semibold tracking-tight text-card-foreground">
              Vad tycker du?
            </h2>
            <p className="mb-5 text-sm text-muted-foreground">
              Du har använt Fiskargubben ett tag — vi vill gärna höra vad du
              tycker! Dela dina tankar i vår Discord, där är du med och
              påverkar vad vi bygger härnäst.
            </p>

            {discordInvite && (
              <>
                <a
                  href={discordInvite}
                  target="_blank"
                  rel="noreferrer"
                  onClick={handleDiscordClick}
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                >
                  Gå med i vår Discord
                </a>

                <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  eller lämna en snabb kommentar
                  <span className="h-px flex-1 bg-border" />
                </div>
              </>
            )}

            <form onSubmit={handleSubmit}>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Vad funkar bra? Vad saknas?"
                maxLength={2000}
                rows={3}
                className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {error && (
                <p className="mt-1 text-xs text-destructive">
                  Det gick inte att skicka — försök igen.
                </p>
              )}
              <button
                type="submit"
                disabled={phase === "sending"}
                className="mt-2 w-full rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 disabled:opacity-50"
              >
                Skicka
              </button>
            </form>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/feedback-prompt-dialog.test.tsx`
Expected: 6 passed. (If the `text-destructive` token doesn't exist in this Tailwind theme, check `git grep text-destructive src/` — if absent, use `text-red-600` instead; assertion is on text, not class.)

- [ ] **Step 5: Wire into AskShell**

Modify `src/app/ask/ask-shell.tsx`:

```tsx
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
```

- [ ] **Step 6: Full test suite + typecheck**

Run: `pnpm test && pnpm tsc --noEmit`
Expected: all green. (If the repo has a `lint`/`check` script in package.json, run that too.)

- [ ] **Step 7: Commit**

```bash
git add src/components/feedback-prompt-dialog.tsx src/components/feedback-prompt-dialog.test.tsx src/app/ask/ask-shell.tsx
git commit --no-verify -m "feat: show feedback prompt dialog to engaged users"
```

---

### Task 5: Funnel query

**Files:**
- Modify: `src/lib/analytics/queries.ts` (append at end)
- Modify: `src/lib/analytics/queries.test.ts` (append a describe block)

**Interfaces:**
- Consumes: the four `feedback_prompt_*` event types (Task 3), existing `QueryDeps`, `Window`, `sinceClause`, `defaultDeps` in queries.ts.
- Produces: `feedbackPromptFunnel(window?: Window, deps?: QueryDeps): Promise<FeedbackPromptFunnel>` where `FeedbackPromptFunnel = { shown: number; dismissed: number; discordClicked: number; submitted: number }`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/analytics/queries.test.ts` (add `feedbackPromptFunnel` to the existing import from `./queries`):

```typescript
describe("feedbackPromptFunnel", () => {
  it("maps event-type counts and defaults missing types to 0", async () => {
    const deps = stubDb([
      [
        { type: "feedback_prompt_shown", n: 40 },
        { type: "feedback_prompt_submitted", n: 5 },
      ],
    ]);
    const out = await feedbackPromptFunnel(undefined, deps);
    expect(out).toEqual({
      shown: 40,
      dismissed: 0,
      discordClicked: 0,
      submitted: 5,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/analytics/queries.test.ts`
Expected: FAIL — `feedbackPromptFunnel` is not exported.

- [ ] **Step 3: Implement the query**

Append to `src/lib/analytics/queries.ts` (also add the four event types to the taxonomy comment block at the top of the file: `feedback_prompt_* payload { userId, chatCount }, submitted adds { message }`):

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Feedback prompt funnel
// ─────────────────────────────────────────────────────────────────────────────

export interface FeedbackPromptFunnel {
  shown: number;
  dismissed: number;
  discordClicked: number;
  submitted: number;
}

/**
 * The feedback prompt funnel in one query: how many prompts were shown, and
 * per channel what happened next (dismissed / went to Discord / submitted the
 * inline form). Spec 2026-07-06-feedback-prompt-design.md.
 */
export async function feedbackPromptFunnel(
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<FeedbackPromptFunnel> {
  const rows = await deps.db.execute<{ type: string; n: number }>(sql`
    SELECT type, COUNT(*)::int AS n
    FROM ${analyticsEvents}
    WHERE type IN ('feedback_prompt_shown', 'feedback_prompt_dismissed',
                   'feedback_prompt_discord_clicked', 'feedback_prompt_submitted')
    ${sinceClause(window)}
    GROUP BY type
  `);
  const by = new Map(rows.map((r) => [r.type, r.n]));
  return {
    shown: by.get("feedback_prompt_shown") ?? 0,
    dismissed: by.get("feedback_prompt_dismissed") ?? 0,
    discordClicked: by.get("feedback_prompt_discord_clicked") ?? 0,
    submitted: by.get("feedback_prompt_submitted") ?? 0,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/analytics/queries.test.ts`
Expected: all passed, including the new block.

- [ ] **Step 5: Full suite + commit**

Run: `pnpm test`
Expected: all green.

```bash
git add src/lib/analytics/queries.ts src/lib/analytics/queries.test.ts
git commit --no-verify -m "feat(analytics): add feedback prompt funnel query"
```
