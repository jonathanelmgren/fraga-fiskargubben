import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The admin allowlist is read from env at call time; stub the validated env
// module so we can vary ADMIN_EMAILS per test without booting the real schema.
const envMock = vi.hoisted(() => ({
  value: { ADMIN_EMAILS: "" as string | undefined },
}));
vi.mock("@/shared/env", () => ({
  get env() {
    return envMock.value;
  },
}));

import { isAdminEmail } from "./is-admin";

afterEach(() => {
  envMock.value = { ADMIN_EMAILS: "" };
});

describe("isAdminEmail", () => {
  it("matches an allowlisted email case-insensitively", () => {
    envMock.value = { ADMIN_EMAILS: "boss@example.com, dev@example.com" };
    expect(isAdminEmail("BOSS@example.com")).toBe(true);
    expect(isAdminEmail("dev@example.com")).toBe(true);
  });

  it("rejects a non-listed email", () => {
    envMock.value = { ADMIN_EMAILS: "boss@example.com" };
    expect(isAdminEmail("intruder@example.com")).toBe(false);
  });

  it("denies everyone when the allowlist is empty or unset", () => {
    envMock.value = { ADMIN_EMAILS: "" };
    expect(isAdminEmail("boss@example.com")).toBe(false);
    envMock.value = { ADMIN_EMAILS: undefined };
    expect(isAdminEmail("boss@example.com")).toBe(false);
  });

  it("never treats null/empty email as admin", () => {
    envMock.value = { ADMIN_EMAILS: "boss@example.com" };
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail("")).toBe(false);
  });
});
