"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { GoogleButton, MicrosoftButton } from "@/app/social-buttons";
import { track } from "@/lib/analytics";
import { authClient, signIn, signUp } from "@/lib/auth-client";

type Mode = "login" | "signup" | "forgot";

const inputClass =
  "rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The single auth surface: a dialog that starts in login mode and flips to
 * signup via "Inte registrerad? Skapa konto här" (rebuild spec — no separate
 * pages, no standalone signup button anywhere).
 */
export function AuthDialog({
  open,
  onClose,
  initialMode = "login",
}: {
  open: boolean;
  onClose: () => void;
  initialMode?: Mode;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [verifySent, setVerifySent] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  // Reset transient state whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setError(null);
      setPassword("");
      setConfirmPassword("");
      setVerifySent(false);
      setResetSent(false);
    }
  }, [open, initialMode]);

  const close = useCallback(() => {
    if (!pending) onClose();
  }, [onClose, pending]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "forgot") {
      setPending(true);
      // Deliberately ignore the result: same "check your inbox" regardless of
      // whether the email has an account (anti-enumeration, matches signup).
      await authClient.requestPasswordReset({
        email,
        redirectTo: "/reset-password",
      });
      setPending(false);
      setResetSent(true);
      return;
    }
    if (mode === "signup" && password !== confirmPassword) {
      setError("Lösenorden matchar inte.");
      return;
    }
    setPending(true);
    const { error } =
      mode === "login"
        ? await signIn.email({ email, password })
        : await signUp.email({
            email,
            password,
            name: name.trim(),
            // Landing page after the verification link is clicked
            // (autoSignInAfterVerification signs the user in there).
            callbackURL: "/",
          });
    setPending(false);
    if (error) {
      // requireEmailVerification: unverified login is rejected with 403
      // EMAIL_NOT_VERIFIED and (sendOnSignIn) a fresh mail is on its way.
      if (error.code === "EMAIL_NOT_VERIFIED") {
        setError(
          "Din e-postadress är inte bekräftad. Vi har skickat ett nytt bekräftelsemejl — kolla din inkorg.",
        );
        return;
      }
      setError(
        error.message ??
          (mode === "login"
            ? "Inloggningen misslyckades"
            : "Registreringen misslyckades"),
      );
      return;
    }
    if (mode === "signup") {
      track("Signup", { method: "email" });
      // No session yet — the account must be verified via the mail link.
      setVerifySent(true);
      return;
    }
    track("Login", { method: "email" });
    onClose();
    router.refresh();
  }

  const isLogin = mode === "login";

  // Portaled to <body>: the site header's backdrop-filter makes it a
  // containing block for fixed descendants, which would trap the overlay
  // inside the header box.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={
        verifySent
          ? "Bekräfta din e-post"
          : resetSent
            ? "Återställningsmejl skickat"
            : isLogin
              ? "Logga in"
              : mode === "forgot"
                ? "Återställ lösenord"
                : "Skapa konto"
      }
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

        {resetSent ? (
          <>
            <h2 className="mb-1 text-xl font-semibold tracking-tight text-card-foreground">
              Kolla din inkorg
            </h2>
            <p className="mb-5 text-sm text-muted-foreground">
              Om <span className="font-medium text-foreground">{email}</span>{" "}
              har ett konto med lösenord skickar vi en återställningslänk dit.
              Länken gäller i en timme.
            </p>
            <button
              type="button"
              onClick={close}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              Stäng
            </button>
          </>
        ) : verifySent ? (
          <>
            <h2 className="mb-1 text-xl font-semibold tracking-tight text-card-foreground">
              Bekräfta din e-post
            </h2>
            <p className="mb-5 text-sm text-muted-foreground">
              Vi har skickat ett mejl till{" "}
              <span className="font-medium text-foreground">{email}</span>.
              Klicka på länken i mejlet för att aktivera ditt konto. Länken
              gäller i en timme.
            </p>
            <button
              type="button"
              onClick={close}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              Stäng
            </button>
          </>
        ) : (
          <>
            <h2 className="mb-1 text-xl font-semibold tracking-tight text-card-foreground">
              {isLogin
                ? "Logga in"
                : mode === "forgot"
                  ? "Återställ lösenord"
                  : "Skapa konto"}
            </h2>
            <p className="mb-5 text-xs text-muted-foreground">
              {isLogin
                ? "Välkommen tillbaka till bryggan."
                : mode === "forgot"
                  ? "Ange din e-postadress så mejlar vi en återställningslänk."
                  : "Tre gratisfrågor att börja med."}
            </p>

            {mode !== "forgot" && (
              <>
                <div className="flex flex-col gap-2">
                  <GoogleButton
                    label={
                      isLogin ? "Logga in med Google" : "Skapa konto med Google"
                    }
                  />
                  <MicrosoftButton
                    label={
                      isLogin
                        ? "Logga in med Microsoft"
                        : "Skapa konto med Microsoft"
                    }
                  />
                </div>

                <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  eller
                  <span className="h-px flex-1 bg-border" />
                </div>
              </>
            )}

            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              {mode === "signup" && (
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Namn
                  <input
                    type="text"
                    required
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={inputClass}
                  />
                </label>
              )}
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                E-post
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass}
                />
              </label>
              {mode !== "forgot" && (
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Lösenord
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoComplete={isLogin ? "current-password" : "new-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={inputClass}
                  />
                </label>
              )}
              {mode === "signup" && (
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Bekräfta lösenord
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className={inputClass}
                  />
                </label>
              )}
              {isLogin && (
                <button
                  type="button"
                  onClick={() => {
                    setMode("forgot");
                    setError(null);
                  }}
                  className="-mt-2 self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Glömt lösenord?
                </button>
              )}

              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={pending}
                className="mt-1 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending
                  ? isLogin
                    ? "Loggar in…"
                    : mode === "forgot"
                      ? "Skickar…"
                      : "Skapar konto…"
                  : isLogin
                    ? "Logga in"
                    : mode === "forgot"
                      ? "Skicka återställningslänk"
                      : "Skapa konto"}
              </button>
            </form>

            <p className="mt-5 text-center text-sm text-muted-foreground">
              {mode === "forgot" ? (
                <button
                  type="button"
                  onClick={() => {
                    setMode("login");
                    setError(null);
                  }}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Tillbaka till inloggning
                </button>
              ) : isLogin ? (
                <>
                  Inte registrerad?{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setMode("signup");
                      setError(null);
                      setVerifySent(false);
                    }}
                    className="font-medium text-foreground underline underline-offset-2"
                  >
                    Skapa konto här
                  </button>
                </>
              ) : (
                <>
                  Har du redan ett konto?{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setMode("login");
                      setError(null);
                      setVerifySent(false);
                    }}
                    className="font-medium text-foreground underline underline-offset-2"
                  >
                    Logga in
                  </button>
                </>
              )}
            </p>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
