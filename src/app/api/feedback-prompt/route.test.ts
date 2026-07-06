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
vi.mock("@/shared/env", () => ({
  env: { BETTER_AUTH_URL: "http://localhost:3000" },
}));
vi.mock("@/lib/get-session", () => ({ getSession: h.getSession }));
vi.mock("@/lib/analytics/events", () => ({ emit: h.emit }));
vi.mock("@/lib/notify/discord", () => ({ notifyDiscord: h.notifyDiscord }));
vi.mock("@/lib/feedback-prompt", () => ({ countUserChats: h.countUserChats }));
vi.mock("@/app/api/ask/route", () => ({
  isSameOriginRequest: h.isSameOriginRequest,
}));

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
    const res = await POST(
      req({ action: "submitted", message: "x".repeat(2001) }),
    );
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
