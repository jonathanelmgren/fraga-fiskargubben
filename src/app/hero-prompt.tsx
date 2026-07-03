"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** sessionStorage handoff key: landing → /ask (chat auto-submits it). */
export const PENDING_PROMPT_KEY = "fg:pending-prompt";

export type PendingPrompt = {
  text: string;
  location?: { lat: number; lon: number };
};

const SUGGESTIONS = [
  "Tolken i kväll",
  "Sämsjön nu",
  "Åsunden i morgon bitti",
];

type GeoState = "off" | "loading" | "on" | "denied";

/**
 * The landing hero's prompt input. Submit stores the prompt (+ optional
 * geolocation) in sessionStorage and navigates to /ask, where the chat
 * auto-submits it and streams the first answer.
 */
export function HeroPrompt() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [geo, setGeo] = useState<GeoState>("off");
  const [coords, setCoords] = useState<
    { lat: number; lon: number } | undefined
  >(undefined);

  function requestLocation() {
    if (geo === "on") {
      setGeo("off");
      setCoords(undefined);
      return;
    }
    if (!("geolocation" in navigator)) {
      setGeo("denied");
      return;
    }
    setGeo("loading");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setGeo("on");
      },
      () => setGeo("denied"),
      { maximumAge: 300_000, timeout: 8_000 },
    );
  }

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    const payload: PendingPrompt = {
      text: trimmed,
      ...(coords ? { location: coords } : {}),
    };
    try {
      sessionStorage.setItem(PENDING_PROMPT_KEY, JSON.stringify(payload));
    } catch {
      // Storage unavailable (private mode edge cases) — /ask starts empty.
    }
    router.push("/ask");
  }

  return (
    <div className="w-full max-w-xl">
      <form
        onSubmit={submit}
        className="flex items-center gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/50"
      >
        <label htmlFor="hero-prompt" className="sr-only">
          Fråga Fiskargubben
        </label>
        <input
          id="hero-prompt"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Jag ska fiska i Tolken i kväll kl 19…"
          className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-[15px] outline-none placeholder:text-muted-foreground/60"
        />
        <button
          type="submit"
          disabled={!text.trim()}
          className="shrink-0 rounded-xl bg-accent px-6 py-2.5 text-sm font-bold text-accent-foreground shadow-sm transition hover:brightness-105 disabled:opacity-50"
        >
          Fråga
        </button>
      </form>

      <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span>Gratis första frågan. Funkar för svenska insjöar.</span>
        <button
          type="button"
          onClick={requestLocation}
          aria-pressed={geo === "on"}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-medium transition-colors ${
            geo === "on"
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border bg-card hover:bg-secondary"
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M12 21s-7-5.4-7-11a7 7 0 1 1 14 0c0 5.6-7 11-7 11Z" />
            <circle cx="12" cy="10" r="2.5" />
          </svg>
          {geo === "on"
            ? "Plats används"
            : geo === "loading"
              ? "Hämtar plats…"
              : geo === "denied"
                ? "Plats nekad"
                : "Använd min plats"}
        </button>
      </div>

      <div className="mt-6 flex flex-wrap justify-center gap-2.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setText(s)}
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm text-foreground/80 shadow-sm transition-colors hover:bg-secondary"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
