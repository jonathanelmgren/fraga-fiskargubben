import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/db/client", () => ({ db: {} }));

import { isFeedbackPromptDue } from "./feedback-prompt";

const DAY = 86_400_000;
const now = new Date("2026-07-06T12:00:00Z");

describe("isFeedbackPromptDue", () => {
  it("is not due before the 3rd chat when never prompted", () => {
    expect(
      isFeedbackPromptDue({
        chatCount: 2,
        promptedAt: null,
        promptedChatCount: 0,
        now,
      }),
    ).toBe(false);
  });

  it("is due at the 3rd chat when never prompted", () => {
    expect(
      isFeedbackPromptDue({
        chatCount: 3,
        promptedAt: null,
        promptedChatCount: 0,
        now,
      }),
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
      isFeedbackPromptDue({
        chatCount: 100,
        promptedAt: null,
        promptedChatCount: 0,
        now,
      }),
    ).toBe(true);
  });
});
