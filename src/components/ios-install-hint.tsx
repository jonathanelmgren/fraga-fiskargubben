"use client";

import { useEffect, useState } from "react";

const DISMISSED_KEY = "ios-install-hint-dismissed";

/**
 * iOS-only "add to home screen" nudge. Safari on iOS never fires
 * beforeinstallprompt and has no install banner of its own, so a manual hint
 * is the only way to surface installability. Shown once — dismissing persists
 * in localStorage — and never inside the installed app (standalone mode).
 */
export function IosInstallHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(DISMISSED_KEY)) return;

    // iPadOS 13+ masquerades as macOS; maxTouchPoints tells it apart.
    const isIos =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.userAgent.includes("Mac") && navigator.maxTouchPoints > 1);
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // Safari-only legacy property, set when launched from the home screen.
      ("standalone" in navigator && navigator.standalone === true);

    setVisible(isIos && !isStandalone);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, "1");
    setVisible(false);
  };

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <div className="mx-auto flex max-w-md items-start gap-3 rounded-xl border border-border bg-card p-3 text-card-foreground shadow-lg">
        <p className="flex-1 text-xs leading-relaxed">
          Lägg till Fiskargubben på hemskärmen: tryck på{" "}
          <span
            aria-hidden="true"
            className="inline-flex size-3.5 translate-y-[2px] items-center justify-center"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M12 3v12" />
              <path d="m8 7 4-4 4 4" />
              <path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
            </svg>
          </span>
          <span className="sr-only">dela-knappen</span> och sedan{" "}
          <span className="font-semibold">”Lägg till på hemskärmen”</span>.
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Stäng"
          className="-m-1 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
