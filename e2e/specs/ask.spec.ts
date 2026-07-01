// e2e: /ask page — anon happy path
//
// Approach A — browser-level route interception via page.route().
//
// Why A and not B (full-live path):
//   The real route requires a live Postgres DB, Anthropic API credentials,
//   and SMHI network access.  None of those are reliably available in CI or
//   local dev without a docker-compose stack.  Approach A intercepts
//   "**/api/ask" at the network boundary so the spec tests:
//     - that the /ask page renders (gubbe, textarea, submit button)
//     - that a streamed text/plain response is consumed and rendered as an
//       assistant bubble
//     - that a second call returning {type:"register_to_continue"} triggers
//       the register CTA
//     - that clicking "Skapa konto" navigates to /register
//
//   The route handler logic (gates, DB writes, Anthropic/SMHI calls) is
//   covered by the ask-handler unit tests (Task 5.7).  The full live
//   integration (real DB + real Anthropic + SMHI) is deferred to a CI
//   environment with a provisioned stack.
//
// Streaming stub:
//   Playwright's page.route() fulfill() sends the body as a complete response,
//   not a true ReadableStream, but the browser sees Content-Type: text/plain
//   with a body, which is sufficient for the chat.tsx reader to pick up the
//   text in one chunk and render it.

import { expect, test } from "@playwright/test";

const FISHING_QUESTION = "Ska jag fiska abborre i Vättern imorgon tidigt?";
const SECOND_QUESTION = "Vilket djup är bäst?";
const CANNED_ADVICE =
  "Abborren är aktiv tidigt på morgonen vid grunda stränder. Prova 2–4 meters djup.";

test.describe("/ask page — anon happy path (route-intercepted)", () => {
  test("renders the ask page with gubbe and input box", async ({ page }) => {
    await page.goto("/ask");

    // Gubbe image visible (alt text used in both the idle state and chat)
    await expect(page.getByAltText("Fiskargubben").first()).toBeVisible();

    // Textarea and submit button present
    await expect(
      page.getByRole("textbox", { name: "Skriv din fråga till Fiskargubben" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Skicka fråga" }),
    ).toBeVisible();
  });

  test("first prompt → advice renders; second prompt → register_to_continue CTA", async ({
    page,
  }) => {
    let callCount = 0;

    // Intercept all POST /api/ask calls
    await page.route("**/api/ask", async (route) => {
      callCount += 1;

      if (callCount === 1) {
        // First call: return a streamed text/plain advice response
        await route.fulfill({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          headers: {
            "X-Conversation-Id": "test-conv-id-1",
          },
          body: CANNED_ADVICE,
        });
      } else {
        // Second call: return the register_to_continue gate
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            type: "register_to_continue",
            text: "Registrera dig för att fortsätta fråga Fiskargubben.",
          }),
        });
      }
    });

    await page.goto("/ask");

    const input = page.getByRole("textbox", {
      name: "Skriv din fråga till Fiskargubben",
    });
    const submitBtn = page.getByRole("button", { name: "Skicka fråga" });

    // ── First prompt ────────────────────────────────────────────────────────
    await input.fill(FISHING_QUESTION);
    await submitBtn.click();

    // The advice text should appear in an assistant bubble
    await expect(page.getByText(CANNED_ADVICE)).toBeVisible({ timeout: 8000 });

    // User message also rendered
    await expect(page.getByText(FISHING_QUESTION)).toBeVisible();

    // ── Second prompt ───────────────────────────────────────────────────────
    // Wait for input to re-enable (streaming finished)
    await expect(input).toBeEnabled({ timeout: 8000 });

    await input.fill(SECOND_QUESTION);
    await submitBtn.click();

    // The register_to_continue CTA should appear
    const ctaBanner = page.getByRole("status");
    await expect(ctaBanner).toBeVisible({ timeout: 8000 });

    // "Skapa konto" link points to /register
    const registerLink = page.getByRole("link", { name: "Skapa konto" });
    await expect(registerLink).toBeVisible();
    await expect(registerLink).toHaveAttribute("href", "/register");

    // "Logga in" link also present
    await expect(page.getByRole("link", { name: "Logga in" })).toBeVisible();
  });

  test("clicking Skapa konto navigates to /register", async ({ page }) => {
    let callCount = 0;

    await page.route("**/api/ask", async (route) => {
      callCount += 1;
      if (callCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          headers: { "X-Conversation-Id": "test-conv-id-2" },
          body: CANNED_ADVICE,
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            type: "register_to_continue",
            text: "Registrera dig för att fortsätta fråga Fiskargubben.",
          }),
        });
      }
    });

    await page.goto("/ask");

    const input = page.getByRole("textbox", {
      name: "Skriv din fråga till Fiskargubben",
    });
    const submitBtn = page.getByRole("button", { name: "Skicka fråga" });

    await input.fill(FISHING_QUESTION);
    await submitBtn.click();
    await expect(page.getByText(CANNED_ADVICE)).toBeVisible({ timeout: 8000 });

    await expect(input).toBeEnabled({ timeout: 8000 });
    await input.fill(SECOND_QUESTION);
    await submitBtn.click();

    // Wait for the CTA to appear, then click "Skapa konto"
    const registerLink = page.getByRole("link", { name: "Skapa konto" });
    await expect(registerLink).toBeVisible({ timeout: 8000 });
    await registerLink.click();

    // Should navigate to /register
    await expect(page).toHaveURL(/\/register/, { timeout: 8000 });
  });
});
