"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export type DrawerItem = {
  id: string;
  title: string;
  /** Pre-formatted Swedish date label (Europe/Stockholm). */
  dateLabel: string;
  status: string;
};

/**
 * Logged-in conversation drawer: current + previous chats and "Ny chatt".
 * Docked on desktop, toggleable overlay on mobile.
 */
export function ChatDrawer({ items }: { items: DrawerItem[] }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const list = (
    <nav aria-label="Dina chattar" className="flex h-full flex-col">
      <div className="p-3">
        <Link
          href="/ask"
          onClick={() => setMobileOpen(false)}
          className="flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          <span aria-hidden="true">+</span> Ny chatt
        </Link>
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {items.length === 0 && (
          <li className="px-2 py-3 text-xs text-muted-foreground">
            Inga tidigare chattar än.
          </li>
        )}
        {items.map((item) => {
          const href = `/ask/${item.id}`;
          const active = pathname === href;
          return (
            <li key={item.id}>
              <Link
                href={href}
                onClick={() => setMobileOpen(false)}
                aria-current={active ? "page" : undefined}
                className={`block rounded-md px-2.5 py-2 text-sm transition-colors ${
                  active
                    ? "bg-secondary font-medium text-foreground"
                    : "text-foreground/75 hover:bg-secondary/60"
                }`}
              >
                <span className="block truncate">{item.title}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {item.dateLabel}
                  {item.status === "lake_pending" && " · osäker sjö"}
                  {item.status === "unresolved_area" && " · område"}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );

  return (
    <>
      {/* Mobile toggle */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Visa dina chattar"
        className="absolute left-3 top-3 rounded-md border border-border bg-card p-2 shadow-sm md:hidden"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
        </svg>
      </button>

      {/* Desktop docked drawer */}
      <aside className="hidden w-60 shrink-0 border-r border-border bg-card/40 md:block">
        {list}
      </aside>

      {/* Mobile overlay drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 md:hidden">
          <button
            type="button"
            aria-label="Stäng"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-foreground/40"
            tabIndex={-1}
          />
          <div className="absolute inset-y-0 left-0 w-64 border-r border-border bg-background shadow-xl">
            {list}
          </div>
        </div>
      )}
    </>
  );
}
