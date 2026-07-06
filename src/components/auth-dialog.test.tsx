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
  authClient: { requestPasswordReset: vi.fn() },
}));

import { authClient, signIn, signUp } from "@/lib/auth-client";
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
  fireEvent.change(screen.getByLabelText("Lösenord"), {
    target: { value: "password123" },
  });
  if (mode === "signup") {
    fireEvent.change(screen.getByLabelText("Bekräfta lösenord"), {
      target: { value: "password123" },
    });
  }
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

  it("portals to document.body so ancestor backdrop-filter (site header) can't trap its fixed positioning", () => {
    render(<AuthDialog open onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog.parentElement).toBe(document.body);
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

  it("signup with mismatched confirm password shows an error and never calls signUp", () => {
    render(<AuthDialog open onClose={vi.fn()} initialMode="signup" />);

    fireEvent.change(screen.getByLabelText(/Namn/), {
      target: { value: "Anna" },
    });
    fireEvent.change(screen.getByLabelText(/E-post/), {
      target: { value: "anna@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Lösenord"), {
      target: { value: "password123" },
    });
    fireEvent.change(screen.getByLabelText("Bekräfta lösenord"), {
      target: { value: "password124" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Skapa konto" }));

    expect(screen.getByText("Lösenorden matchar inte.")).toBeTruthy();
    expect(signUp.email).not.toHaveBeenCalled();
  });

  it("forgot-password flow requests a reset and shows the check-inbox panel", async () => {
    vi.mocked(authClient.requestPasswordReset).mockResolvedValue({
      data: {},
      error: null,
    } as never);
    render(<AuthDialog open onClose={vi.fn()} initialMode="login" />);

    fireEvent.click(screen.getByRole("button", { name: "Glömt lösenord?" }));
    fireEvent.change(screen.getByLabelText(/E-post/), {
      target: { value: "anna@example.com" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Skicka återställningslänk" }),
    );

    await waitFor(() => {
      expect(screen.getByText(/Kolla din inkorg/)).toBeTruthy();
    });
    expect(authClient.requestPasswordReset).toHaveBeenCalledWith({
      email: "anna@example.com",
      redirectTo: "/reset-password",
    });
  });
});
