import "server-only";
import { Resend } from "resend";
import { notifyDiscord } from "@/lib/notify/discord";
import { env } from "@/shared/env";

/**
 * Transactional mail via Resend. Only one mail exists today: the email
 * verification link for email/password signups (better-auth wires it in
 * src/lib/auth.ts).
 *
 * Never throws: signup/login must succeed or fail on their own merits, and
 * better-auth re-sends the mail on the next unverified login attempt
 * (sendOnSignIn), so a lost mail is self-healing. Failures are logged and
 * pinged to the Discord alerts channel.
 *
 * No RESEND_API_KEY (dev/CI): logs the verification URL to the console so
 * the flow is testable locally without a Resend account.
 */
export async function sendVerificationEmail({
  to,
  name,
  url,
}: {
  to: string;
  name: string;
  url: string;
}): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.warn(
      `[email] RESEND_API_KEY not set — verification mail NOT sent to ${to}. Verify manually: ${url}`,
    );
    return;
  }

  try {
    const resend = new Resend(env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: env.EMAIL_FROM,
      to,
      subject: "Bekräfta din e-postadress – Fiskargubben",
      text: [
        `Hej ${name}!`,
        "",
        "Bekräfta din e-postadress genom att öppna länken nedan:",
        url,
        "",
        "Länken gäller i en timme. Om du inte skapade ett konto kan du ignorera det här mejlet.",
      ].join("\n"),
      html: `
        <p>Hej ${name}!</p>
        <p>Bekräfta din e-postadress genom att klicka på knappen nedan:</p>
        <p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px">Bekräfta e-postadress</a></p>
        <p>Eller öppna länken: <a href="${url}">${url}</a></p>
        <p>Länken gäller i en timme. Om du inte skapade ett konto kan du ignorera det här mejlet.</p>
      `,
    });
    if (error) {
      console.error(`[email] verification mail to ${to} failed:`, error);
      void notifyDiscord(
        "alerts",
        `⚠️ Verifieringsmejl till ${to} misslyckades: ${error.message}`,
      ).catch(() => {});
    }
  } catch (err) {
    console.error(`[email] verification mail to ${to} threw:`, err);
    void notifyDiscord(
      "alerts",
      `⚠️ Verifieringsmejl till ${to} misslyckades (exception)`,
    ).catch(() => {});
  }
}
