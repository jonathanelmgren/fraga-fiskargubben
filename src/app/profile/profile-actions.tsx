"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * Client half of the profile page: the premium upsell (49 kr — STUB, no
 * payment provider wired) and the delete-account danger zone.
 */
export function ProfileActions({
  isPaid,
  isAdmin,
}: {
  isPaid: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [premiumClicked, setPremiumClicked] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function deleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    const { error } = await authClient.deleteUser();
    if (error) {
      setDeleting(false);
      setDeleteError(error.message ?? "Kunde inte ta bort kontot.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <>
      {/* Premium (stub) */}
      <section
        aria-label="Premium"
        className="mt-6 rounded-xl border border-accent/50 bg-accent/10 p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Premium</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Obegränsade frågor till gubben.{" "}
              <span className="font-semibold text-foreground">49 kr/mån</span>
            </p>
          </div>
          {isPaid || isAdmin ? (
            <span className="rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground">
              {isAdmin ? "Admin, allt ingår" : "Premium aktivt"}
            </span>
          ) : premiumClicked ? (
            <span className="text-sm font-medium text-foreground/80">
              Betalning kommer snart. Håll ut, hörru.
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setPremiumClicked(true)}
              className="rounded-lg bg-accent px-5 py-2.5 text-sm font-bold text-accent-foreground shadow-sm transition hover:brightness-105"
            >
              Uppgradera för 49 kr
            </button>
          )}
        </div>
      </section>

      {/* Danger zone */}
      <section
        aria-label="Ta bort konto"
        className="mt-6 rounded-xl border border-destructive/40 p-6"
      >
        <h2 className="text-base font-semibold text-destructive">
          Ta bort konto
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Tar bort ditt konto och alla dina chattar permanent. Det här går inte
          att ångra.
        </p>
        {deleteError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {deleteError}
          </p>
        )}
        <div className="mt-4 flex items-center gap-3">
          {confirmingDelete ? (
            <>
              <button
                type="button"
                disabled={deleting}
                onClick={deleteAccount}
                className="rounded-md bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {deleting ? "Tar bort…" : "Ja, ta bort allt"}
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => setConfirmingDelete(false)}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-secondary"
              >
                Avbryt
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded-md border border-destructive/50 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
            >
              Ta bort mitt konto
            </button>
          )}
        </div>
      </section>
    </>
  );
}
