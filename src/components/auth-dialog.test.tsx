/**
 * auth-dialog.test.tsx — email-verification states of the auth dialog.
 *
 * Coverage (spec 2026-07-06-email-verification-design.md):
 *  1. Successful signup does NOT close the dialog — it shows the
 *     "check your inbox" panel with the submitted email.
 *  2. signUp.email is called with callbackURL "/" (verify link lands there).
 *  3. Login rejected with EMAIL_NOT_VERIFIED shows the specific Swedish
 *     "verify first, new mail sent" message.
 *  4. Other login errors still show the generic message path (regression).
 *
 * Same conventions as chat.test.tsx: no jest-dom, plain expect() assertions.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock("@/app/social-buttons", () => ({
  GoogleButton: () => null,
  MicrosoftButton: () => null,
}));

vi.mock("@/lib/auth-client", () => ({
  signIn: { email: vi.fn() },
  signUp: { email: vi.fn() },
}));

import { signIn, signUp } from "@/lib/auth-client";
import { AuthDialog } from "./auth-dialog";

function fillAndSubmit(mode: "login" | "signup") {
  if (mode === "signup") {
    fireEvent.change(screen.getByLabelText(/Namn/), {
      target: { value: "Anna" },
    });
  }
  fireEvent.change(screen.getByLabelText(/E-post/), {
    target: { value: "anna@example.com" },
  });
  fireEvent.change(screen.getByLabelText(/Lösenord/), {
    target: { value: "password123" },
  });
  fireEvent.submit(
    screen.getByRole("button", {
      name: mode === "signup" ? "Skapa konto" : "Logga in",
    }),
  );
}

describe("AuthDialog — email verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("signup success shows the check-your-inbox panel and keeps the dialog open", async () => {
    vi.mocked(signUp.email).mockResolvedValue({
      data: {},
      error: null,
    } as never);
    const onClose = vi.fn();
    render(<AuthDialog open onClose={onClose} initialMode="signup" />);

    fillAndSubmit("signup");

    await waitFor(() => {
      expect(screen.getByText(/anna@example\.com/)).toBeTruthy();
    });
    expect(screen.getByText(/Bekräfta din e-post/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("passes callbackURL '/' to signUp.email", async () => {
    vi.mocked(signUp.email).mockResolvedValue({
      data: {},
      error: null,
    } as never);
    render(<AuthDialog open onClose={vi.fn()} initialMode="signup" />);

    fillAndSubmit("signup");

    await waitFor(() => {
      expect(signUp.email).toHaveBeenCalledWith(
        expect.objectContaining({ callbackURL: "/" }),
      );
    });
  });

  it("unverified login shows the verify-first message", async () => {
    vi.mocked(signIn.email).mockResolvedValue({
      data: null,
      error: {
        code: "EMAIL_NOT_VERIFIED",
        status: 403,
        message: "Email not verified",
      },
    } as never);
    render(<AuthDialog open onClose={vi.fn()} initialMode="login" />);

    fillAndSubmit("login");

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("inte bekräftad");
    });
    expect(screen.getByRole("alert").textContent).toContain("bekräftelsemejl");
  });

  it("other login errors keep the generic path (regression)", async () => {
    vi.mocked(signIn.email).mockResolvedValue({
      data: null,
      error: { code: "INVALID_EMAIL_OR_PASSWORD", status: 401, message: null },
    } as never);
    render(<AuthDialog open onClose={vi.fn()} initialMode="login" />);

    fillAndSubmit("login");

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Inloggningen misslyckades",
      );
    });
  });

  it("resets the verify-sent panel when the dialog re-opens", async () => {
    vi.mocked(signUp.email).mockResolvedValue({
      data: {},
      error: null,
    } as never);
    const { rerender } = render(
      <AuthDialog open onClose={vi.fn()} initialMode="signup" />,
    );

    fillAndSubmit("signup");
    await waitFor(() => {
      expect(screen.getByText(/Bekräfta din e-post/)).toBeTruthy();
    });

    rerender(
      <AuthDialog open={false} onClose={vi.fn()} initialMode="signup" />,
    );
    rerender(<AuthDialog open onClose={vi.fn()} initialMode="signup" />);

    expect(screen.queryByText(/Bekräfta din e-post/)).toBeNull();
    expect(screen.getByRole("button", { name: "Skapa konto" })).toBeTruthy();
  });
});
