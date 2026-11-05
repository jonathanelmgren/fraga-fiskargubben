// @vitest-environment node
/**
 * Drives the real Better Auth router through auth.handler, on an in-memory
 * adapter, so the signup gate and ping are checked against the paths Better Auth
 * really reports rather than against a stubbed context.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  user: [] as { id: string; email: string }[],
  session: [] as unknown[],
  account: [] as { userId: string; providerId: string }[],
  verification: [] as unknown[],
}));
const mail = vi.hoisted(() => ({ verifyUrl: null as string | null }));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "00000000000000000000000000000000",
    BETTER_AUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "x",
    GOOGLE_CLIENT_SECRET: "x",
    MICROSOFT_CLIENT_ID: "x",
    MICROSOFT_CLIENT_SECRET: "x",
  },
}));
vi.mock("@/shared/db/client", () => ({
  // Only afterEmailVerification's credential-account lookup reaches this.
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            store.account.filter((a) => a.providerId === "credential"),
        }),
      }),
    }),
  },
}));
vi.mock("better-auth/adapters/drizzle", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter(store as never) };
});
vi.mock("better-auth/next-js", () => ({
  nextCookies: () => ({ id: "next-cookies" }),
}));
vi.mock("@/lib/auth/signup-ip", () => ({
  checkSignupAllowed: async () => ({ allowed: true, ipHash: null }),
  SIGNUP_IP_LIMIT_MESSAGE: "limit",
}));
vi.mock("@/lib/analytics/events", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/notify/discord", () => ({
  notifyDiscord: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/email", () => ({
  sendVerificationEmail: vi.fn(async ({ url }: { url: string }) => {
    mail.verifyUrl = url;
  }),
  sendExistingAccountEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

import { emit } from "@/lib/analytics/events";
import { sendVerificationEmail } from "@/lib/email";
import { notifyDiscord } from "@/lib/notify/discord";
import { auth } from "./auth";
import { issueSignupToken } from "./auth/signup-token";
import {
  SIGNUP_HONEYPOT_HEADER,
  SIGNUP_TOKEN_HEADER,
  SIGNUP_TOKEN_MIN_AGE_MS,
} from "./auth/signup-token-shared";

const SIGN_UP_URL = "http://localhost:3000/api/auth/sign-up/email";

function postSignup(
  headers: Record<string, string> = {},
  url: string = SIGN_UP_URL,
) {
  return auth.handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        name: "Probe",
        email: "probe@example.com",
        password: "Passw0rd-probe",
      }),
    }),
  );
}

function formHeaders() {
  const issuedAt = new Date(Date.now() - SIGNUP_TOKEN_MIN_AGE_MS);
  return { [SIGNUP_TOKEN_HEADER]: issueSignupToken(issuedAt) };
}

describe("email signup through the real Better Auth router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.user.length = 0;
    store.session.length = 0;
    store.account.length = 0;
    store.verification.length = 0;
    mail.verifyUrl = null;
  });

  it("a scripted POST without a token creates nothing and pings nobody", async () => {
    const res = await postSignup();

    expect(res.status).toBe(403);
    expect(store.user).toHaveLength(0);
    expect(notifyDiscord).not.toHaveBeenCalled();
    expect(sendVerificationEmail).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({ type: "signup_bot_blocked" });
  });

  it.each([
    ["trailing slash", `${SIGN_UP_URL}/`],
    ["query string", `${SIGN_UP_URL}?x=1`],
  ])("the gate cannot be skipped with a %s", async (_name, url) => {
    await postSignup({}, url);

    expect(store.user).toHaveLength(0);
    expect(notifyDiscord).not.toHaveBeenCalled();
  });

  it("a filled honeypot is rejected even with a valid token", async () => {
    const res = await postSignup({
      ...formHeaders(),
      [SIGNUP_HONEYPOT_HEADER]: "1",
    });

    expect(res.status).toBe(403);
    expect(store.user).toHaveLength(0);
  });

  it("a blocked POST for an existing address sends no notice mail", async () => {
    await postSignup(formHeaders());
    const { sendExistingAccountEmail } = await import("@/lib/email");

    await postSignup();

    expect(sendExistingAccountEmail).not.toHaveBeenCalled();
  });

  it("a form signup creates the row but pings only once the mail is verified", async () => {
    const res = await postSignup(formHeaders());

    expect(res.status).toBe(200);
    expect(store.user).toHaveLength(1);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(notifyDiscord).not.toHaveBeenCalled();

    await auth.handler(new Request(mail.verifyUrl as string));

    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    expect(notifyDiscord).toHaveBeenCalledWith(
      "signups",
      "🎣 Ny användare: Probe (probe@example.com)",
    );
  });

  it("clicking the verification link again does not ping twice", async () => {
    await postSignup(formHeaders());
    const verifyUrl = mail.verifyUrl as string;

    await auth.handler(new Request(verifyUrl));
    await auth.handler(new Request(verifyUrl));

    expect(notifyDiscord).toHaveBeenCalledTimes(1);
  });
});
