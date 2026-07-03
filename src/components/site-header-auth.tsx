"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthDialog } from "./auth-dialog";
import { AvatarMenu } from "./avatar-menu";

/**
 * The auth corner of the header. `?auth=1` (the redirect target of the old
 * /login and /register routes) auto-opens the dialog once, then cleans the
 * URL so refreshes don't reopen it.
 */
export function HeaderAuth({
  user,
}: {
  user: { name: string; isAdmin: boolean } | null;
}) {
  const [authOpen, setAuthOpen] = useState(false);
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const authParam = searchParams.get("auth");
  useEffect(() => {
    if (authParam && !user) {
      setAuthOpen(true);
      router.replace(pathname, { scroll: false });
    }
  }, [authParam, user, router, pathname]);

  if (user) {
    return <AvatarMenu name={user.name} isAdmin={user.isAdmin} />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setAuthOpen(true)}
        className="rounded-md border border-border bg-card px-4 py-2 text-sm font-medium transition-colors hover:bg-secondary"
      >
        Logga in
      </button>
      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />
    </>
  );
}
