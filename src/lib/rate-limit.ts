import "server-only";

/**
 * Minimal in-memory sliding-window rate limiter. Per-process state — correct
 * for the single-container deployment (one `node server.js`); revisit with a
 * shared store (Redis/Postgres) if the app ever scales horizontally.
 *
 * Complements the credit/quota gates in ask-handler.ts: those bound total
 * cost, this blunts request bursts before any gate logic (or LLM token) runs.
 */

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

/** Lazy sweep: drop expired windows so the map doesn't grow unbounded. */
function sweep(now: number) {
  if (windows.size < 10_000) return;
  for (const [key, w] of windows) {
    if (w.resetAt <= now) windows.delete(key);
  }
}

/**
 * Count a hit for `key` and report whether it is within `limit` hits per
 * `windowMs`. Fixed-window (resets fully at expiry) — good enough for burst
 * protection.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  sweep(now);
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  w.count += 1;
  return {
    allowed: w.count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - now) / 1000)),
  };
}

/** Test hook. */
export function resetRateLimiter() {
  windows.clear();
}
