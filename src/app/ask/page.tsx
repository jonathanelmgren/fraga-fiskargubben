import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import gubbeIconImg from "@/assets/gubbe-icon.png";
import { getSession } from "@/lib/get-session";
import Chat from "./chat";

export const metadata: Metadata = {
  title: "Fråga Fiskargubben — Chatt",
};

export default async function AskPage() {
  const session = await getSession();

  return (
    <div className="ask-page flex flex-col h-screen bg-background">
      {/* Header */}
      <header className="ask-header shrink-0 flex items-center justify-between px-4 py-3 border-b border-border bg-card/70 backdrop-blur-sm">
        <Link href="/" className="flex items-center gap-2 group">
          <Image
            src={gubbeIconImg}
            alt=""
            width={28}
            height={28}
            className="rounded-full opacity-80 group-hover:opacity-100 transition-opacity"
            aria-hidden="true"
          />
          <span className="text-sm font-semibold tracking-tight text-foreground/80 group-hover:text-foreground transition-colors">
            Fiskargubben
          </span>
        </Link>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {session ? (
            <span className="truncate max-w-[160px]">{session.user.name}</span>
          ) : (
            <Link
              href="/login"
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-secondary"
            >
              Logga in
            </Link>
          )}
        </div>
      </header>

      {/* Chat fills remaining space */}
      <div className="flex-1 overflow-hidden">
        <Chat />
      </div>
    </div>
  );
}
