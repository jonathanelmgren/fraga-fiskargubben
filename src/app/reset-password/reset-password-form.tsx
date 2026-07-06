"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const inputClass =
  "rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ResetPasswordForm({
  token,
  callbackError,
}: {
  token: string | null;
  callbackError: string | null;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  // Expired/used/missing token: the only fix is requesting a fresh mail.
  if (!token || callbackError) {
    return (
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-7 shadow-sm text-center">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">
          Länken fungerar inte längre
        </h1>
        <p className="mb-5 text-sm text-muted-foreground">
          Återställningslänken är ogiltig eller har gått ut (den gäller i en
          timme). Begär en ny via "Glömt lösenord?" i inloggningen.
        </p>
        <Link
          href="/?auth=1"
          className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          Till inloggningen
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-7 shadow-sm text-center">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">
          Lösenordet är bytt
        </h1>
        <p className="mb-5 text-sm text-muted-foreground">
          Du kan nu logga in med ditt nya lösenord.
        </p>
        <Link
          href="/?auth=1"
          className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          Logga in
        </Link>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("Lösenorden matchar inte.");
      return;
    }
    setPending(true);
    const { error } = await authClient.resetPassword({
      newPassword: password,
      token: token as string,
    });
    setPending(false);
    if (error) {
      setError(error.message ?? "Kunde inte byta lösenordet. Försök igen.");
      return;
    }
    setDone(true);
    router.refresh();
  }

  return (
    <div className="w-full max-w-sm rounded-xl border border-border bg-card p-7 shadow-sm">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">
        Välj nytt lösenord
      </h1>
      <p className="mb-5 text-xs text-muted-foreground">
        Minst 8 tecken. Alla andra inloggade enheter loggas ut.
      </p>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Nytt lösenord
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
        </label>
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
          {pending ? "Byter lösenord…" : "Byt lösenord"}
        </button>
      </form>
    </div>
  );
}
