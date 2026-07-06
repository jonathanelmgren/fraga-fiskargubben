import "server-only";
import { Resend } from "resend";
import { notifyDiscord } from "@/lib/notify/discord";
import { env } from "@/shared/env";

/** Minimal HTML entity escape for user-supplied text in the HTML body. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Transactional mail via Resend. Two mails exist today: the email
 * verification link for email/password signups, and the "you already have an
 * account" notice for duplicate signups (both wired in src/lib/auth.ts).
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
    if (process.env.NODE_ENV === "production") {
      void notifyDiscord(
        "alerts",
        `⚠️ RESEND_API_KEY saknas i prod — verifieringsmejl till ${to} skickades ALDRIG.`,
      ).catch(() => {});
    }
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
        <p>Hej ${escapeHtml(name)}!</p>
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
      `⚠️ Verifieringsmejl till ${to} misslyckades: ${err instanceof Error ? err.message : String(err)}`,
    ).catch(() => {});
  }
}

/** Swedish sign-in method names per better-auth account.providerId. */
const PROVIDER_LABELS: Record<string, string> = {
  credential: "e-post och lösenord",
  google: "Google",
  microsoft: "Microsoft",
};

/**
 * Sent when someone tries to register with an email that already has an
 * account (better-auth's onExistingUserSignUp hook). The signup UI shows the
 * same generic "check your inbox" for new and existing emails — anti-
 * enumeration — so this mail is where the real story is told: you already
 * have an account, and here is how you sign in to it.
 *
 * Same never-throws contract as sendVerificationEmail.
 */
export async function sendExistingAccountEmail({
  to,
  name,
  providers,
}: {
  to: string;
  name: string;
  providers: string[];
}): Promise<void> {
  const methods = providers.map((p) => PROVIDER_LABELS[p] ?? p).join(" eller ");
  const signInHint = methods
    ? `Logga in med ${methods} som vanligt.`
    : "Logga in som vanligt.";

  if (!env.RESEND_API_KEY) {
    console.warn(
      `[email] RESEND_API_KEY not set — existing-account mail NOT sent to ${to}. (${signInHint})`,
    );
    return;
  }

  try {
    const resend = new Resend(env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: env.EMAIL_FROM,
      to,
      subject: "Du har redan ett konto – Fiskargubben",
      text: [
        `Hej ${name}!`,
        "",
        "Någon (förhoppningsvis du) försökte skapa ett konto hos Fiskargubben med den här e-postadressen — men du har redan ett konto.",
        signInHint,
        "",
        "Om det inte var du kan du ignorera det här mejlet. Inget nytt konto har skapats och ditt lösenord är oförändrat.",
      ].join("\n"),
      html: `
        <p>Hej ${escapeHtml(name)}!</p>
        <p>Någon (förhoppningsvis du) försökte skapa ett konto hos Fiskargubben med den här e-postadressen — men du har redan ett konto.</p>
        <p><strong>${escapeHtml(signInHint)}</strong></p>
        <p>Om det inte var du kan du ignorera det här mejlet. Inget nytt konto har skapats och ditt lösenord är oförändrat.</p>
      `,
    });
    if (error) {
      console.error(`[email] existing-account mail to ${to} failed:`, error);
    }
  } catch (err) {
    console.error(`[email] existing-account mail to ${to} threw:`, err);
  }
}
