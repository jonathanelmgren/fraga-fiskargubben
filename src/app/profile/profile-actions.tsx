"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * Client half of the profile page: the premium upsell (Stripe Checkout via
 * @better-auth/stripe) and the delete-account danger zone.
 */
export function ProfileActions({
  isPaid,
  isAdmin,
  priceLabel,
}: {
  isPaid: boolean;
  isAdmin: boolean;
  /** "39 kr/år"-style label from Stripe, or null when unavailable. */
  priceLabel: string | null;
}) {
  const router = useRouter();
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** Redirects to Stripe Checkout; only returns here on error. */
  async function upgrade() {
    setBillingBusy(true);
    setBillingError(null);
    const { data, error } = await authClient.subscription.upgrade({
      plan: "premium",
      successUrl: "/profile",
      cancelUrl: "/profile",
    });
    if (error) {
      setBillingBusy(false);
      setBillingError(error.message ?? "Kunde inte starta betalningen.");
      return;
    }
    // better-auth normally redirects itself; belt-and-suspenders if it didn't.
    if (data && "url" in data && typeof data.url === "string") {
      window.location.href = data.url;
    }
  }

  /** Stripe Billing Portal: change card, cancel, see receipts. */
  async function manageSubscription() {
    setBillingBusy(true);
    setBillingError(null);
    const { data, error } = await authClient.subscription.billingPortal({
      returnUrl: "/profile",
    });
    if (error) {
      setBillingBusy(false);
      setBillingError(error.message ?? "Kunde inte öppna hanteringssidan.");
      return;
    }
    if (data && "url" in data && typeof data.url === "string") {
      window.location.href = data.url;
    }
  }

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
      {/* Premium */}
      <section
        aria-label="Premium"
        className="mt-6 rounded-xl border border-accent/50 bg-accent/10 p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">Premium</h2>
              {isPaid && !isAdmin && (
                <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground">
                  Aktiv
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Obegränsade frågor till gubben.
              {priceLabel && (
                <>
                  {" "}
                  <span className="font-semibold text-foreground">
                    {priceLabel}
                  </span>
                </>
              )}
            </p>
          </div>
          {isAdmin ? (
            <span className="rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground">
              Admin, allt ingår
            </span>
          ) : isPaid ? (
            <button
              type="button"
              disabled={billingBusy}
              onClick={manageSubscription}
              className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium transition-colors hover:bg-secondary disabled:opacity-50"
            >
              {billingBusy ? "Öppnar…" : "Hantera prenumeration"}
            </button>
          ) : (
            <button
              type="button"
              disabled={billingBusy}
              onClick={upgrade}
              className="rounded-lg bg-accent px-5 py-2.5 text-sm font-bold text-accent-foreground shadow-sm transition hover:brightness-105 disabled:opacity-50"
            >
              {billingBusy
                ? "Skickar till betalning…"
                : priceLabel
                  ? `Uppgradera för ${priceLabel}`
                  : "Uppgradera"}
            </button>
          )}
        </div>
        {billingError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {billingError}
          </p>
        )}
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
