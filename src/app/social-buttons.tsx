"use client";

import { useState } from "react";
import { signIn } from "@/lib/auth-client";

function useSocial(provider: "google" | "microsoft") {
  const [pending, setPending] = useState(false);
  const start = async () => {
    setPending(true);
    await signIn.social({ provider, callbackURL: "/" });
  };
  return { pending, start };
}

const btnClass =
  "flex items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-secondary disabled:opacity-50";

export function GoogleButton({ label }: { label: string }) {
  const { pending, start } = useSocial("google");
  return (
    <button
      type="button"
      disabled={pending}
      onClick={start}
      className={btnClass}
    >
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"
        />
        <path
          fill="#34A853"
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
        />
        <path
          fill="#FBBC05"
          d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
        />
        <path
          fill="#EA4335"
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
        />
      </svg>
      {pending ? "Redirecting…" : label}
    </button>
  );
}

export function MicrosoftButton({ label }: { label: string }) {
  const { pending, start } = useSocial("microsoft");
  return (
    <button
      type="button"
      disabled={pending}
      onClick={start}
      className={btnClass}
    >
      <svg viewBox="0 0 21 21" className="size-4" aria-hidden="true">
        <path fill="#f25022" d="M1 1h9v9H1z" />
        <path fill="#7fba00" d="M11 1h9v9h-9z" />
        <path fill="#00a4ef" d="M1 11h9v9H1z" />
        <path fill="#ffb900" d="M11 11h9v9h-9z" />
      </svg>
      {pending ? "Redirecting…" : label}
    </button>
  );
}
