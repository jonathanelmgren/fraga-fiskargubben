/**
 * Discord webhook notifications — ops pings, not user-facing.
 *
 * Two channels via two webhook URLs (create in Discord: channel settings →
 * Integrations → Webhooks → copy URL):
 *   DISCORD_WEBHOOK_ALERTS  — server errors (instrumentation + /api/ask)
 *   DISCORD_WEBHOOK_SIGNUPS — new registrations (feedback, signups)
 *
 * Unset env → silent no-op, so dev/CI never depends on Discord. Reads
 * process.env directly (not @/shared/env) so instrumentation.ts can import
 * this without dragging in the full env schema in every runtime.
 *
 * Fire-and-forget by design: a Discord outage must never break a request.
 * Callers that cannot await (hooks) should still .catch(() => {}).
 *
 * allowed_mentions is always suppressed — content is user-supplied and must
 * never resolve @everyone/@here/role mentions in the channel.
 */

const DISCORD_TIMEOUT_MS = 5000;

/** Discord hard-caps message content at 2000 chars. */
const MAX_CONTENT_LENGTH = 1900;

type Channel = "alerts" | "signups";

function webhookUrl(channel: Channel): string | undefined {
  return channel === "alerts"
    ? process.env.DISCORD_WEBHOOK_ALERTS
    : process.env.DISCORD_WEBHOOK_SIGNUPS;
}

export async function notifyDiscord(
  channel: Channel,
  content: string,
): Promise<void> {
  const url = webhookUrl(channel);
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // allowed_mentions: user-supplied content must never resolve mentions.
      body: JSON.stringify({
        content: content.slice(0, MAX_CONTENT_LENGTH),
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
  } catch (err) {
    // Never propagate — log and move on.
    console.error(`[discord] ${channel} webhook failed:`, err);
  }
}
