"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { signOut } from "@/lib/auth-client";

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

/**
 * Logged-in header control: initials avatar with a small dropdown
 * (Mina chattar, Profil, Statistik for admins, Logga ut).
 */
export function AvatarMenu({
  name,
  isAdmin,
}: {
  name: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Konto: ${name}`}
        className="flex size-9 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-sm ring-2 ring-transparent transition hover:ring-ring/50"
      >
        {initialsOf(name)}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 w-44 overflow-hidden rounded-lg border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
        >
          <div className="border-b border-border px-3 py-2">
            <p className="truncate text-xs font-medium">{name}</p>
          </div>
          <Link
            href="/ask"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 transition-colors hover:bg-secondary"
          >
            Mina chattar
          </Link>
          <Link
            href="/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 transition-colors hover:bg-secondary"
          >
            Profil
          </Link>
          {isAdmin && (
            <Link
              href="/admin/analytics"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 transition-colors hover:bg-secondary"
            >
              Statistik
            </Link>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              await signOut();
              router.push("/");
              router.refresh();
            }}
            className="block w-full px-3 py-2 text-left transition-colors hover:bg-secondary"
          >
            Logga ut
          </button>
        </div>
      )}
    </div>
  );
}
