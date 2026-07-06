import "server-only";

import Stripe from "stripe";
import { env } from "@/shared/env";

/**
 * Display price for the premium plan, resolved from Stripe by lookup_key so
 * a Dashboard price change (new Price + transfer_lookup_key) shows up here
 * without a code or env change. Must match the plan lookupKey in
 * src/lib/auth.ts.
 */
export const PREMIUM_LOOKUP_KEY = "premium_yearly";

const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; label: string | null } | null = null;

const INTERVAL_SV: Record<string, string> = {
  day: "dag",
  week: "vecka",
  month: "mån",
  year: "år",
};

/**
 * "39 kr/år"-style label for the premium plan, or null when Stripe is not
 * configured / unreachable (callers render price-less copy). Cached in-process
 * for 5 min so the profile page doesn't hit Stripe on every render.
 */
export async function getPremiumPriceLabel(): Promise<string | null> {
  if (!env.STRIPE_SECRET_KEY) return null;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.label;

  try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const { data } = await stripe.prices.list({
      lookup_keys: [PREMIUM_LOOKUP_KEY],
      active: true,
      limit: 1,
    });
    const price = data[0];
    let label: string | null = null;
    if (price?.unit_amount != null && price.recurring) {
      const amount = new Intl.NumberFormat("sv-SE", {
        style: "currency",
        currency: price.currency.toUpperCase(),
        maximumFractionDigits: 0,
      }).format(price.unit_amount / 100);
      const interval =
        INTERVAL_SV[price.recurring.interval] ?? price.recurring.interval;
      label = `${amount}/${interval}`;
    }
    cache = { at: Date.now(), label };
    return label;
  } catch {
    // Stripe hiccup: serve the stale label if we have one, price-less otherwise.
    return cache?.label ?? null;
  }
}
