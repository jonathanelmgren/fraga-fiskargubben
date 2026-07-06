/**
 * email.test.ts — verification-mail sender.
 *
 * Contract (spec 2026-07-06-email-verification-design.md):
 *  1. No RESEND_API_KEY → no send attempt; logs the URL (local-dev path).
 *  2. Key set → resend.emails.send called with from/to/subject and the URL
 *     in both html and text bodies.
 *  3. Resend returns { error } → Discord "alerts" ping, never throws.
 *  4. Resend rejects (network) → swallowed, never throws.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockState = {
  sendMock: vi.fn(),
};

vi.mock("resend", async () => {
  // biome-ignore lint/suspicious/noExplicitAny: mocking constructor with this binding
  const Resend = vi.fn(function (this: any) {
    this.emails = { send: mockState.sendMock };
  });
  return { Resend };
});

vi.mock("@/lib/notify/discord", () => ({
  notifyDiscord: vi.fn().mockResolvedValue(undefined),
}));

// Mock env with default state; envState will be mutated in tests
vi.mock("@/shared/env", () => {
  return {
    env: {
      RESEND_API_KEY: undefined as string | undefined,
      EMAIL_FROM: "Fiskargubben <noreply@fragafiskargubben.se>",
    },
  };
});

import { notifyDiscord } from "@/lib/notify/discord";
import { env } from "@/shared/env";
import { sendExistingAccountEmail, sendVerificationEmail } from "./email";

const args = {
  to: "anna@example.com",
  name: "Anna",
  url: "http://localhost:3000/api/auth/verify-email?token=t&callbackURL=%2F",
};

const sendMock = mockState.sendMock;

describe("sendVerificationEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.RESEND_API_KEY = undefined;
  });

  it("does not send when RESEND_API_KEY is unset; logs the URL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendVerificationEmail(args);
    expect(sendMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain(args.url);
    expect(notifyDiscord).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("pings Discord when RESEND_API_KEY is unset in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendVerificationEmail(args);
    expect(sendMock).not.toHaveBeenCalled();
    expect(notifyDiscord).toHaveBeenCalledWith(
      "alerts",
      expect.stringContaining("anna@example.com"),
    );
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it("sends via Resend with from/to/subject and the URL in the body", async () => {
    env.RESEND_API_KEY = "re_test";
    sendMock.mockResolvedValue({ data: { id: "1" }, error: null });

    await sendVerificationEmail(args);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0];
    expect(payload.from).toBe("Fiskargubben <noreply@fragafiskargubben.se>");
    expect(payload.to).toBe("anna@example.com");
    expect(payload.subject).toContain("Bekräfta");
    expect(payload.html).toContain(args.url);
    expect(payload.text).toContain(args.url);
  });

  it("alerts Discord and does not throw when Resend returns an error", async () => {
    env.RESEND_API_KEY = "re_test";
    sendMock.mockResolvedValue({
      data: null,
      error: { message: "domain not verified", name: "validation_error" },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendVerificationEmail(args)).resolves.toBeUndefined();
    expect(notifyDiscord).toHaveBeenCalledWith(
      "alerts",
      expect.stringContaining("anna@example.com"),
    );
    error.mockRestore();
  });

  it("does not throw when Resend rejects (network failure)", async () => {
    env.RESEND_API_KEY = "re_test";
    sendMock.mockRejectedValue(new Error("ECONNRESET"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendVerificationEmail(args)).resolves.toBeUndefined();
    expect(notifyDiscord).toHaveBeenCalledWith(
      "alerts",
      expect.stringContaining("ECONNRESET"),
    );
    error.mockRestore();
  });

  it("escapes HTML in the user-supplied name", async () => {
    env.RESEND_API_KEY = "re_test";
    sendMock.mockResolvedValue({ data: { id: "1" }, error: null });

    await sendVerificationEmail({ ...args, name: '<img src=x onerror="x">' });

    const payload = sendMock.mock.calls[0][0];
    expect(payload.html).not.toContain("<img");
    expect(payload.html).toContain("&lt;img");
  });
});

describe("sendExistingAccountEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.RESEND_API_KEY = undefined;
  });

  const existingArgs = {
    to: "anna@example.com",
    name: "Anna",
    providers: ["google"],
  };

  it("does not send when RESEND_API_KEY is unset", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendExistingAccountEmail(existingArgs);
    expect(sendMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("names the user's actual sign-in methods in the body", async () => {
    env.RESEND_API_KEY = "re_test";
    sendMock.mockResolvedValue({ data: { id: "1" }, error: null });

    await sendExistingAccountEmail({
      ...existingArgs,
      providers: ["google", "credential"],
    });

    const payload = sendMock.mock.calls[0][0];
    expect(payload.to).toBe("anna@example.com");
    expect(payload.subject).toContain("redan ett konto");
    expect(payload.text).toContain("Google eller e-post och lösenord");
    expect(payload.html).toContain("Google eller e-post och lösenord");
  });

  it("does not throw when Resend rejects", async () => {
    env.RESEND_API_KEY = "re_test";
    sendMock.mockRejectedValue(new Error("ECONNRESET"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendExistingAccountEmail(existingArgs),
    ).resolves.toBeUndefined();
    error.mockRestore();
  });
});
