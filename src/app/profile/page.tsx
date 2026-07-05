import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { FREE_CREDITS } from "@/lib/chat/quota";
import { getSession } from "@/lib/get-session";
import { isAdminEmail } from "@/lib/is-admin";
import { db } from "@/shared/db/client";
import { users } from "@/shared/db/schema";
import { ProfileActions } from "./profile-actions";

export const metadata: Metadata = {
  title: "Fråga Fiskargubben — Profil",
};

const memberSinceFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  dateStyle: "long",
});

export default async function ProfilePage() {
  const session = await getSession();
  if (!session) redirect("/?auth=1");

  const rows = await db
    .select({
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
      creditsUsed: users.creditsUsed,
      isPaid: users.isPaid,
    })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  const user = rows[0];
  if (!user) redirect("/?auth=1");

  const isAdmin = isAdminEmail(user.email);
  const unlimited = user.isPaid || isAdmin;
  const creditsLeft = Math.max(0, FREE_CREDITS - user.creditsUsed);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10">
      <h1 className="text-2xl font-bold tracking-tight">Din profil</h1>

      {/* Account data */}
      <section
        aria-label="Kontouppgifter"
        className="mt-6 rounded-xl border border-border bg-card p-6"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Kontouppgifter
        </h2>
        <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Namn</dt>
            <dd className="font-medium">{user.name}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">E-post</dt>
            <dd className="font-medium">{user.email}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Medlem sedan</dt>
            <dd className="font-medium">
              {memberSinceFmt.format(user.createdAt)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Frågor kvar</dt>
            <dd className="font-medium">
              {unlimited
                ? isAdmin
                  ? "Obegränsat (admin)"
                  : "Obegränsat (premium)"
                : `${creditsLeft} av ${FREE_CREDITS} gratisfrågor`}
            </dd>
          </div>
        </dl>
      </section>

      {/* Premium + danger zone (client) */}
      <ProfileActions isPaid={user.isPaid} isAdmin={isAdmin} />
    </main>
  );
}
