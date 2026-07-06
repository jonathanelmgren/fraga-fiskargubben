"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export const SUPPORT_EMAIL = "kontakt@fragafiskargubben.se";

/**
 * Every support entry point (footer link, profile button, …) opens this
 * dialog instead of linking straight to Discord: chat on Discord for the
 * quick route, or plain email for everyone else.
 */
export function SupportButton({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {children}
      </button>
      {open && <SupportDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function SupportDialog({ onClose }: { onClose: () => void }) {
  // NEXT_PUBLIC_* is inlined at build time, so the client can read it directly.
  const discordInvite = process.env.NEXT_PUBLIC_DISCORD_INVITE;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portaled to <body>: the site header's backdrop-filter makes it a
  // containing block for fixed descendants (same pattern as AuthDialog).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Support"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Stäng"
        onClick={onClose}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-[2px] cursor-default"
        tabIndex={-1}
      />

      <div className="relative w-full max-w-sm rounded-xl border border-border bg-card p-7 shadow-xl">
        <button
          type="button"
          onClick={onClose}
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

        <h2 className="mb-1 text-xl font-semibold tracking-tight text-card-foreground">
          Support
        </h2>
        <p className="mb-5 text-sm text-muted-foreground">
          Snabbast svar får du i vår Discord, men det går lika bra att mejla.
        </p>

        {discordInvite && (
          <>
            <a
              href={discordInvite}
              target="_blank"
              rel="noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              Gå med i vår Discord och chatta
            </a>

            <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              eller
              <span className="h-px flex-1 bg-border" />
            </div>
          </>
        )}

        <p className="text-center text-sm text-muted-foreground">
          Mejla oss på{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="font-medium text-foreground underline underline-offset-2"
          >
            {SUPPORT_EMAIL}
          </a>
        </p>
      </div>
    </div>,
    document.body,
  );
}
