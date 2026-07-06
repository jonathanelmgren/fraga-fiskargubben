/**
 * Plausible custom-event tracking (self-hosted at analytics.mysterylane.se).
 * The script is only rendered in production (src/app/layout.tsx), so this
 * no-ops in dev/tests. Event names must match the goals configured in
 * Plausible for conversions to show up.
 */

type EventProps = Record<string, string | number | boolean>;

declare global {
  interface Window {
    plausible?: (event: string, options?: { props?: EventProps }) => void;
  }
}

export function track(event: string, props?: EventProps) {
  if (typeof window === "undefined") return;
  window.plausible?.(event, props ? { props } : undefined);
}
