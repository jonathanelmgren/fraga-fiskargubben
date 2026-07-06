# Email Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require email verification for email/password signups, using better-auth's built-in link verification with Resend as the mail sender.

**Architecture:** A thin mail module (`src/lib/email.ts`) wraps the Resend SDK. `src/lib/auth.ts` turns on `requireEmailVerification` and wires the `emailVerification` block to that module. The auth dialog gains a "check your inbox" state after signup and a specific error message when an unverified user tries to log in. No DB migration — the `verification` table and `user.email_verified` column already exist.

**Tech Stack:** Next.js 16, better-auth 1.6.22, Resend SDK, Drizzle/Postgres, Vitest + @testing-library/react, Zod env validation.

**Spec:** `docs/superpowers/specs/2026-07-06-email-verification-design.md`

## Global Constraints

- **Read Next.js docs first:** per `AGENTS.md`, this repo runs a Next.js version with breaking changes — read the relevant guide in `node_modules/next/dist/docs/` before writing any Next-specific code (client components, `next/navigation`).
- Package manager is **pnpm** (v10). Node 24.
- All user-facing copy is **Swedish** (see existing copy in `auth-dialog.tsx`).
- Lint: `pnpm biome:fix` before committing. Pre-commit hook has a biome version drift — commit with `git commit --no-verify`.
- Tests: `pnpm test` (vitest). Type check: `pnpm ts:check`.
- Mail sending must **never throw** into the auth flow — signup/login must succeed/fail on their own merits; mail failures are logged + Discord-alerted (channel `"alerts"` via `notifyDiscord` from `@/lib/notify/discord`).
- `RESEND_API_KEY` is **optional** in the env schema (CI/dev boot without it; Dockerfile build-time placeholders need no update). When unset, the sender logs the verification URL to console instead — this is the local-dev testing path.
- Verification behavior in better-auth 1.6.22 (verified against `node_modules/better-auth/dist/api/routes/sign-in.mjs`): with `requireEmailVerification: true`, unverified login throws 403 with error code `EMAIL_NOT_VERIFIED`; a new verification mail on login attempt is sent **only if `sendOnSignIn: true`** — the plan sets it.

---

### Task 1: Env vars + mail sender module

**Files:**
- Modify: `src/shared/env.ts` (add two vars to the Zod schema)
- Modify: `.env.example` (document them)
- Create: `src/lib/email.ts`
- Test: `src/lib/email.test.ts`

**Interfaces:**
- Consumes: `env` from `@/shared/env`, `notifyDiscord(channel, content)` from `@/lib/notify/discord`, `Resend` from `resend`.
- Produces: `sendVerificationEmail({ to, name, url }: { to: string; name: string; url: string }): Promise<void>` — exported from `src/lib/email.ts`. Task 2 imports exactly this.

- [ ] **Step 1: Install the Resend SDK**

```bash
pnpm add resend
```

- [ ] **Step 2: Add env vars to the schema**

In `src/shared/env.ts`, add to the `z.object({...})` (after the `MICROSOFT_CLIENT_SECRET` line):

```typescript
  /**
   * Resend API key for transactional mail (email verification). Optional so
   * dev/CI boot without it — when unset, src/lib/email.ts logs the
   * verification URL to the console instead of sending (local testing path).
   */
  RESEND_API_KEY: z.string().min(1).optional(),
  /**
   * From-address for transactional mail. The domain must be verified in the
   * Resend dashboard (fragagubben.se).
   */
  EMAIL_FROM: z.string().default("Fiskargubben <noreply@fragagubben.se>"),
```

- [ ] **Step 3: Document in `.env.example`**

Add after the `MICROSOFT_CLIENT_SECRET=` block:

```bash
# Resend — transactional mail (email verification). https://resend.com/api-keys
# Optional: unset in dev/CI logs the verification URL to console instead.
# EMAIL_FROM domain must be verified in the Resend dashboard.
RESEND_API_KEY=
EMAIL_FROM=Fiskargubben <noreply@fragagubben.se>
```

- [ ] **Step 4: Write the failing test**

Create `src/lib/email.test.ts`:

```typescript
/**
 * email.test.ts — verification-mail sender.
 *
 * Contract (spec 2026-07-06-email-verification-design.md):
 *  1. No RESEND_API_KEY → no send attempt; logs the URL (local-dev path).
 *  2. Key set → resend.emails.send called with from/to/subject and the URL
 *     in both html and text bodies.
 *  3. Resend returns { error } → Discord "alerts" ping, never throws.
 *  4. Resend rejects (network) → swallowed, never throws.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));

vi.mock("@/lib/notify/discord", () => ({ notifyDiscord: vi.fn() }));

const envState = {
  RESEND_API_KEY: undefined as string | undefined,
  EMAIL_FROM: "Fiskargubben <noreply@fragagubben.se>",
};
vi.mock("@/shared/env", () => ({ env: envState }));

import { notifyDiscord } from "@/lib/notify/discord";
import { sendVerificationEmail } from "./email";

const args = {
  to: "anna@example.com",
  name: "Anna",
  url: "http://localhost:3000/api/auth/verify-email?token=t&callbackURL=%2F",
};

describe("sendVerificationEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.RESEND_API_KEY = undefined;
  });

  it("does not send when RESEND_API_KEY is unset; logs the URL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendVerificationEmail(args);
    expect(sendMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain(args.url);
    warn.mockRestore();
  });

  it("sends via Resend with from/to/subject and the URL in the body", async () => {
    envState.RESEND_API_KEY = "re_test";
    sendMock.mockResolvedValue({ data: { id: "1" }, error: null });

    await sendVerificationEmail(args);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0];
    expect(payload.from).toBe("Fiskargubben <noreply@fragagubben.se>");
    expect(payload.to).toBe("anna@example.com");
    expect(payload.subject).toContain("Bekräfta");
    expect(payload.html).toContain(args.url);
    expect(payload.text).toContain(args.url);
  });

  it("alerts Discord and does not throw when Resend returns an error", async () => {
    envState.RESEND_API_KEY = "re_test";
    sendMock.mockResolvedValue({
      data: null,
      error: { message: "domain not verified", name: "validation_error" },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendVerificationEmail(args)).resolves.toBeUndefined();
    expect(notifyDiscord).toHaveBeenCalledWith(
      "alerts",
      expect.stringContaining("anna@example.com"),
    );
    error.mockRestore();
  });

  it("does not throw when Resend rejects (network failure)", async () => {
    envState.RESEND_API_KEY = "re_test";
    sendMock.mockRejectedValue(new Error("ECONNRESET"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendVerificationEmail(args)).resolves.toBeUndefined();
    expect(notifyDiscord).toHaveBeenCalled();
    error.mockRestore();
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm vitest run src/lib/email.test.ts`
Expected: FAIL — `Cannot find module './email'` (or equivalent resolve error).

- [ ] **Step 6: Write the implementation**

Create `src/lib/email.ts`:

```typescript
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
```

Note: `name` comes from better-auth's user record (self-chosen display name), and the HTML is our own template — no third-party interpolation risk beyond the user's own name in their own mail.

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run src/lib/email.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Type check + lint**

Run: `pnpm ts:check && pnpm biome:fix`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml src/shared/env.ts .env.example src/lib/email.ts src/lib/email.test.ts
git commit --no-verify -m "feat(email): add Resend verification-mail sender"
```

---

### Task 2: Turn on verification in better-auth config

**Files:**
- Modify: `src/lib/auth.ts` (the `emailAndPassword` block at lines 33–41; add an `emailVerification` block after it)
- Test: `src/lib/auth.test.ts` (add a describe block; add one `vi.mock`)

**Interfaces:**
- Consumes: `sendVerificationEmail({ to, name, url })` from `@/lib/email` (Task 1).
- Produces: better-auth config with `requireEmailVerification: true` + `emailVerification` wired. The client behavior Task 3 relies on: signup sends mail and does NOT auto-sign-in; unverified login returns 403 with code `EMAIL_NOT_VERIFIED` and re-sends the mail (`sendOnSignIn: true`).

- [ ] **Step 1: Write the failing test**

In `src/lib/auth.test.ts`:

First, add this mock next to the other `vi.mock` calls (before the `import { auth } from "./auth")` line):

```typescript
// Mock the mail sender so the verification wire can be asserted.
vi.mock("@/lib/email", () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));
```

And import it with the other imports:

```typescript
import { sendVerificationEmail } from "@/lib/email";
```

Then append this describe block at the end of the file:

```typescript
describe("email verification config (spec 2026-07-06)", () => {
  it("requires email verification for email/password", () => {
    expect(opts?.emailAndPassword?.requireEmailVerification).toBe(true);
  });

  it("sends on signup and on unverified sign-in, auto-signs-in after verify, 1h expiry", () => {
    expect(opts?.emailVerification?.sendOnSignUp).toBe(true);
    expect(opts?.emailVerification?.sendOnSignIn).toBe(true);
    expect(opts?.emailVerification?.autoSignInAfterVerification).toBe(true);
    expect(opts?.emailVerification?.expiresIn).toBe(3600);
  });

  it("wires sendVerificationEmail to the Resend module with to/name/url", async () => {
    vi.mocked(sendVerificationEmail).mockClear();

    await opts?.emailVerification?.sendVerificationEmail?.({
      user: { email: "anna@example.com", name: "Anna" },
      url: "http://localhost:3000/api/auth/verify-email?token=t",
      token: "t",
    });

    expect(sendVerificationEmail).toHaveBeenCalledWith({
      to: "anna@example.com",
      name: "Anna",
      url: "http://localhost:3000/api/auth/verify-email?token=t",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/auth.test.ts`
Expected: FAIL — the three new tests fail (`requireEmailVerification` is `false`, `emailVerification` is `undefined`). The six existing C2 tests must still PASS.

- [ ] **Step 3: Update `src/lib/auth.ts`**

Add the import at the top (with the other `@/lib` imports):

```typescript
import { sendVerificationEmail } from "@/lib/email";
```

Replace the `emailAndPassword` block (currently lines 33–41):

```typescript
  emailAndPassword: {
    enabled: true,
    // Open registration: anyone can sign up. Abuse is bounded by the signup
    // IP guard in the user.create.before hook.
    disableSignUp: false,
    minPasswordLength: 8,
    // Unverified accounts cannot sign in (403 EMAIL_NOT_VERIFIED); the mail
    // path is src/lib/email.ts (Resend). OAuth (Google/Microsoft) accounts
    // are treated as verified by better-auth and are unaffected.
    requireEmailVerification: true,
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({ to: user.email, name: user.name, url });
    },
    // Mail on signup AND on every unverified login attempt — a lost first
    // mail is self-healing (the user just tries to log in again).
    sendOnSignUp: true,
    sendOnSignIn: true,
    // Clicking the link both verifies and signs in, landing on callbackURL.
    autoSignInAfterVerification: true,
    expiresIn: 3600, // 1 hour
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/auth.test.ts`
Expected: PASS (9 tests: 6 existing C2 + 3 new).

- [ ] **Step 5: Type check + lint**

Run: `pnpm ts:check && pnpm biome:fix`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth.ts src/lib/auth.test.ts
git commit --no-verify -m "feat(auth): require email verification for email/password signups"
```

---

### Task 3: Auth dialog — "check your inbox" state + unverified-login message

**Files:**
- Modify: `src/components/auth-dialog.tsx`
- Test: `src/components/auth-dialog.test.tsx` (new)

**Interfaces:**
- Consumes: `signIn.email` / `signUp.email` from `@/lib/auth-client` (better-auth react client). Error shape on unverified login: `{ error: { code: "EMAIL_NOT_VERIFIED", status: 403, message: "Email not verified" } }` (server code verified in Task 2 / Global Constraints).
- Produces: UI only — no exports consumed by later tasks.

Behavior to implement:
1. Signup success → dialog does NOT close; it shows a "check your inbox" panel (Swedish) with the submitted email address. Closing the dialog afterwards is the only action (button "Stäng").
2. `signUp.email` gets `callbackURL: "/"` so the verification link lands the user on the start page, signed in (autoSignInAfterVerification).
3. Login error with code `EMAIL_NOT_VERIFIED` → specific Swedish message: a new verification mail has been sent (sendOnSignIn is on).
4. The verify-sent state resets when the dialog re-opens (existing `useEffect` on `open`).

- [ ] **Step 1: Write the failing test**

Create `src/components/auth-dialog.test.tsx`:

```typescript
/**
 * auth-dialog.test.tsx — email-verification states of the auth dialog.
 *
 * Coverage (spec 2026-07-06-email-verification-design.md):
 *  1. Successful signup does NOT close the dialog — it shows the
 *     "check your inbox" panel with the submitted email.
 *  2. signUp.email is called with callbackURL "/" (verify link lands there).
 *  3. Login rejected with EMAIL_NOT_VERIFIED shows the specific Swedish
 *     "verify first, new mail sent" message.
 *  4. Other login errors still show the generic message path (regression).
 *
 * Same conventions as chat.test.tsx: no jest-dom, plain expect() assertions.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock("@/app/social-buttons", () => ({
  GoogleButton: () => null,
  MicrosoftButton: () => null,
}));

vi.mock("@/lib/auth-client", () => ({
  signIn: { email: vi.fn() },
  signUp: { email: vi.fn() },
}));

import { signIn, signUp } from "@/lib/auth-client";
import { AuthDialog } from "./auth-dialog";

function fillAndSubmit(mode: "login" | "signup") {
  if (mode === "signup") {
    fireEvent.change(screen.getByLabelText(/Namn/), {
      target: { value: "Anna" },
    });
  }
  fireEvent.change(screen.getByLabelText(/E-post/), {
    target: { value: "anna@example.com" },
  });
  fireEvent.change(screen.getByLabelText(/Lösenord/), {
    target: { value: "password123" },
  });
  fireEvent.submit(
    screen.getByRole("button", {
      name: mode === "signup" ? "Skapa konto" : "Logga in",
    }),
  );
}

describe("AuthDialog — email verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("signup success shows the check-your-inbox panel and keeps the dialog open", async () => {
    vi.mocked(signUp.email).mockResolvedValue({ data: {}, error: null });
    const onClose = vi.fn();
    render(<AuthDialog open onClose={onClose} initialMode="signup" />);

    fillAndSubmit("signup");

    await waitFor(() => {
      expect(screen.getByText(/anna@example\.com/)).toBeTruthy();
    });
    expect(screen.getByText(/Bekräfta din e-post/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("passes callbackURL '/' to signUp.email", async () => {
    vi.mocked(signUp.email).mockResolvedValue({ data: {}, error: null });
    render(<AuthDialog open onClose={vi.fn()} initialMode="signup" />);

    fillAndSubmit("signup");

    await waitFor(() => {
      expect(signUp.email).toHaveBeenCalledWith(
        expect.objectContaining({ callbackURL: "/" }),
      );
    });
  });

  it("unverified login shows the verify-first message", async () => {
    vi.mocked(signIn.email).mockResolvedValue({
      data: null,
      error: {
        code: "EMAIL_NOT_VERIFIED",
        status: 403,
        message: "Email not verified",
      },
    });
    render(<AuthDialog open onClose={vi.fn()} initialMode="login" />);

    fillAndSubmit("login");

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "inte bekräftad",
      );
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "bekräftelsemejl",
    );
  });

  it("other login errors keep the generic path (regression)", async () => {
    vi.mocked(signIn.email).mockResolvedValue({
      data: null,
      error: { code: "INVALID_EMAIL_OR_PASSWORD", status: 401, message: null },
    });
    render(<AuthDialog open onClose={vi.fn()} initialMode="login" />);

    fillAndSubmit("login");

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Inloggningen misslyckades",
      );
    });
  });
});
```

Note: better-auth's mocked return values above are structural (`{ data, error }`) — if `vi.mocked(...).mockResolvedValue` complains about exact types, cast the value with `as never`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/auth-dialog.test.tsx`
Expected: FAIL — tests 1–3 fail (no verify-sent panel, no callbackURL, generic error message). Test 4 may already pass.

- [ ] **Step 3: Update `src/components/auth-dialog.tsx`**

Three changes:

**(a)** Add state + reset. After the `pending` state declaration (line 33):

```typescript
  const [verifySent, setVerifySent] = useState(false);
```

In the existing open-reset `useEffect` (lines 36–42), add `setVerifySent(false);` alongside `setError(null)`.

**(b)** Replace the `onSubmit` function (lines 59–79):

```typescript
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error } =
      mode === "login"
        ? await signIn.email({ email, password })
        : await signUp.email({
            email,
            password,
            name: name.trim(),
            // Landing page after the verification link is clicked
            // (autoSignInAfterVerification signs the user in there).
            callbackURL: "/",
          });
    setPending(false);
    if (error) {
      // requireEmailVerification: unverified login is rejected with 403
      // EMAIL_NOT_VERIFIED and (sendOnSignIn) a fresh mail is on its way.
      if (error.code === "EMAIL_NOT_VERIFIED") {
        setError(
          "Din e-postadress är inte bekräftad. Vi har skickat ett nytt bekräftelsemejl — kolla din inkorg.",
        );
        return;
      }
      setError(
        error.message ??
          (mode === "login"
            ? "Inloggningen misslyckades"
            : "Registreringen misslyckades"),
      );
      return;
    }
    if (mode === "signup") {
      // No session yet — the account must be verified via the mail link.
      setVerifySent(true);
      return;
    }
    onClose();
    router.refresh();
  }
```

**(c)** Render the verify-sent panel. Inside the card `<div className="relative w-full max-w-sm ...">`, wrap everything below the close (×) button in a conditional. When `verifySent` is true, render this instead of the heading/social/form/footer:

```tsx
        {verifySent ? (
          <>
            <h2 className="mb-1 text-xl font-semibold tracking-tight text-card-foreground">
              Bekräfta din e-post
            </h2>
            <p className="mb-5 text-sm text-muted-foreground">
              Vi har skickat ett mejl till{" "}
              <span className="font-medium text-foreground">{email}</span>.
              Klicka på länken i mejlet för att aktivera ditt konto. Länken
              gäller i en timme.
            </p>
            <button
              type="button"
              onClick={close}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              Stäng
            </button>
          </>
        ) : (
          <>
            {/* existing content: heading, social buttons, divider, form, mode-switch footer — unchanged */}
          </>
        )}
```

(Keep the existing content verbatim inside the `<>...</>` else-branch; only the wrapping is new.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/auth-dialog.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite, type check, lint**

Run: `pnpm test && pnpm ts:check && pnpm biome:fix`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/components/auth-dialog.tsx src/components/auth-dialog.test.tsx
git commit --no-verify -m "feat(ui): verify-email state in auth dialog"
```

---

### Task 4: Manual smoke test (local, no Resend key)

**Files:** none (verification only)

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d
pnpm dev
```

- [ ] **Step 2: Sign up with email/password**

In the browser: open the auth dialog → "Skapa konto här" → register with a fresh email (e.g. `smoke+1@example.com`).

Expected:
- Dialog shows "Bekräfta din e-post" with the address.
- Dev-server console logs `[email] RESEND_API_KEY not set — verification mail NOT sent to smoke+1@example.com. Verify manually: http://localhost:3000/api/auth/verify-email?token=...`.

- [ ] **Step 3: Verify login is blocked before verification**

Close the dialog, open it again, try to log in with the same credentials.

Expected: red message "Din e-postadress är inte bekräftad. Vi har skickat ett nytt bekräftelsemejl — kolla din inkorg." and a fresh `[email] ...` console line (sendOnSignIn).

- [ ] **Step 4: Verify the link works**

Copy the logged verification URL into the browser.

Expected: redirected to `/`, signed in (autoSignInAfterVerification). Check the DB if in doubt:

```bash
docker compose exec -T db psql -U postgres -d fiskargubben -c "select email, email_verified from \"user\" order by created_at desc limit 3;"
```

Expected: `email_verified = t` for the smoke user.

- [ ] **Step 5: Verify Google OAuth is unaffected**

Log out, sign in with Google. Expected: works exactly as before (no verification step).

- [ ] **Step 6: Clean up the smoke user**

Delete via the profile page's self-service account deletion, or:

```bash
docker compose exec -T db psql -U postgres -d fiskargubben -c "delete from \"user\" where email like 'smoke+%';"
```

---

## Production checklist (post-merge, manual)

Not part of the code tasks — needed before this works in prod:

1. Resend account: verify the `fragagubben.se` domain (SPF + DKIM DNS records shown in the Resend dashboard).
2. Create an API key and add `RESEND_API_KEY=` to the prod env file on the VPS (the fragagubben deployment reads env at runtime via `--env-file`; no image rebuild needed for env-only changes, just a container restart).
3. Optionally set `EMAIL_FROM` if a different sender name is wanted (defaults to `Fiskargubben <noreply@fragagubben.se>`).
