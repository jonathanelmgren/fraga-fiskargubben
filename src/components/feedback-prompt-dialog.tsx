"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type FunnelAction = "shown" | "dismissed" | "discord_clicked" | "submitted";

function send(
  action: FunnelAction,
  message?: string,
): Promise<{ ok: boolean }> {
  return fetch("/api/feedback-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      message === undefined ? { action } : { action, message },
    ),
    // Survives the tab navigating away (e.g. straight to Discord).
    keepalive: true,
  });
}

/**
 * Feedback prompt (spec 2026-07-06-feedback-prompt-design.md): rendered by
 * AskShell only when the server-side gate says it is due, so mounting = the
 * prompt IS shown; the mount effect stamps that on the server. Discord first,
 * quick-feedback textarea second. "dismissed" is only emitted when the user
 * closes without clicking Discord or submitting.
 */
export function FeedbackPromptDialog() {
  // AskShell renders this during SSR (the gate is server-side), but the
  // portal target is document.body — render nothing until mounted so the
  // server pass never touches `document` (ReferenceError, digest eb8d1abf).
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(true);
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<"form" | "sending" | "thanks">("form");
  const [error, setError] = useState(false);
  // True once the user clicked Discord or submitted — suppresses "dismissed".
  const actedRef = useRef(false);
  const shownSentRef = useRef(false);

  // NEXT_PUBLIC_* is inlined at build time, so the client can read it directly.
  const discordInvite = process.env.NEXT_PUBLIC_DISCORD_INVITE;

  useEffect(() => {
    setMounted(true);
    if (shownSentRef.current) return; // StrictMode double-invoke guard
    shownSentRef.current = true;
    send("shown").catch(() => {});
  }, []);

  const close = useCallback(() => {
    // No-op when already closed — prevents duplicate "dismissed" from stale listeners.
    setOpen((prev) => {
      if (!prev) return prev;
      if (!actedRef.current) send("dismissed").catch(() => {});
      return false;
    });
  }, []);

  useEffect(() => {
    // Only attach when the dialog is open — detaches on close so Escape
    // presses after dismissal never re-fire "dismissed".
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!mounted || !open) return null;

  const handleDiscordClick = () => {
    actedRef.current = true;
    send("discord_clicked").catch(() => {});
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = message.trim();
    if (!text || phase === "sending") return;
    setPhase("sending");
    setError(false);
    try {
      const res = await send("submitted", text);
      if (!res.ok) throw new Error("submit failed");
      actedRef.current = true;
      setPhase("thanks");
    } catch {
      setPhase("form");
      setError(true);
    }
  };

  // Portaled to <body>: the site header's backdrop-filter makes it a
  // containing block for fixed descendants (same pattern as SupportDialog).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Feedback"
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

        {phase === "thanks" ? (
          <p className="py-6 text-center text-base font-medium text-card-foreground">
            Tack för din feedback! 🎣
          </p>
        ) : (
          <>
            <h2 className="mb-1 text-xl font-semibold tracking-tight text-card-foreground">
              Vad tycker du?
            </h2>
            <p className="mb-5 text-sm text-muted-foreground">
              Du har använt Fiskargubben ett tag — vi vill gärna höra vad du
              tycker! Dela dina tankar i vår Discord, där är du med och påverkar
              vad vi bygger härnäst.
            </p>

            {discordInvite && (
              <>
                <a
                  href={discordInvite}
                  target="_blank"
                  rel="noreferrer"
                  onClick={handleDiscordClick}
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                >
                  Gå med i vår Discord
                </a>

                <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  eller lämna en snabb kommentar
                  <span className="h-px flex-1 bg-border" />
                </div>
              </>
            )}

            <form onSubmit={handleSubmit}>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Vad funkar bra? Vad saknas?"
                maxLength={2000}
                rows={3}
                className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {error && (
                <p className="mt-1 text-xs text-destructive">
                  Det gick inte att skicka — försök igen.
                </p>
              )}
              <button
                type="submit"
                disabled={phase === "sending"}
                className="mt-2 w-full rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 disabled:opacity-50"
              >
                Skicka
              </button>
            </form>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
