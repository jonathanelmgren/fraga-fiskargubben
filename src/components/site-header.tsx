import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import gubbeIconImg from "@/assets/gubbe-icon.png";
import { getSession } from "@/lib/get-session";
import { isAdminEmail } from "@/lib/is-admin";
import { HeaderAuth } from "./site-header-auth";

/**
 * Shared site header (rebuild spec): brand, "Så funkar det", and a single
 * auth control — "Logga in" opening the auth dialog when logged out, the
 * initials avatar menu when logged in. There is deliberately NO signup
 * button; signup lives inside the dialog.
 */
export async function SiteHeader() {
  const session = await getSession();
  const user = session
    ? {
        name: session.user.name,
        isAdmin: isAdminEmail(session.user.email),
      }
    : null;

  return (
    // Fixed h-14: the /ask pages size their chat column as calc(100dvh - 3.5rem).
    <header className="sticky top-0 flex h-14 items-center justify-between border-b border-border bg-background/85 px-4 backdrop-blur-sm sm:px-6">
      <Link href="/" className="group flex items-center gap-2.5">
        <Image
          src={gubbeIconImg}
          alt=""
          width={34}
          height={34}
          className="rounded-full transition-opacity group-hover:opacity-90"
          aria-hidden="true"
        />
        <span className="text-[15px] font-bold tracking-tight text-foreground">
          Fråga Fiskargubben
        </span>
      </Link>

      <nav className="flex items-center gap-4 sm:gap-6">
        <Link
          href="/#sa-funkar-det"
          className="hidden text-sm font-medium text-foreground/80 transition-colors hover:text-foreground sm:block"
        >
          Så funkar det
        </Link>
        {/* useSearchParams (auth=1 auto-open) requires a Suspense boundary. */}
        <Suspense
          fallback={<span className="block h-9 w-20" aria-hidden="true" />}
        >
          <HeaderAuth user={user} />
        </Suspense>
      </nav>
    </header>
  );
}
