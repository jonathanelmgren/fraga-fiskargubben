import Link from "next/link";
import { getSession } from "@/lib/get-session";
import { SignOutButton } from "./sign-out-button";

export default async function Home() {
  const session = await getSession();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">fiskargubben</h1>
      {session ? (
        <div className="flex flex-col items-center gap-4">
          <p className="text-muted-foreground">
            Signed in as{" "}
            <span className="font-medium text-foreground">
              {session.user.email}
            </span>
          </p>
          <SignOutButton />
        </div>
      ) : (
        <div className="flex gap-3">
          <Link
            href="/register"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Create account
          </Link>
          <Link
            href="/login"
            className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-secondary"
          >
            Sign in
          </Link>
        </div>
      )}
    </main>
  );
}
