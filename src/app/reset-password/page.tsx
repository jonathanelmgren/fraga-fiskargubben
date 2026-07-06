import { ResetPasswordForm } from "./reset-password-form";

export const metadata = { title: "Återställ lösenord – Fiskargubben" };

/**
 * Landing page for the password-reset mail link. better-auth's
 * GET /api/auth/reset-password/:token callback validates the token and
 * redirects here with ?token=… (or ?error=INVALID_TOKEN when expired/used).
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <ResetPasswordForm token={token ?? null} callbackError={error ?? null} />
    </main>
  );
}
