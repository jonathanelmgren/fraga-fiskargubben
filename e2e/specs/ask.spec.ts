// e2e: /ask page — anon flows with route interception.
//
// The real route needs Postgres + Anthropic + SMHI; page.route() intercepts
// "**/api/ask" at the network boundary so these specs exercise the UI only.
// Handler logic is covered by the ask-handler unit tests.

import { expect, test } from "@playwright/test";

const FISHING_QUESTION = "Ska jag fiska abborre i Vättern imorgon tidigt?";
const SECOND_QUESTION = "Vilket djup är bäst?";
const CANNED_ADVICE =
  "Abborren är aktiv tidigt på morgonen vid grunda stränder. Prova 2–4 meters djup.";

const BADGES = {
  lake: "Vättern (Jönköping, Jönköping)",
  status: "resolved",
  airTempC: 17.3,
  windMs: 4.2,
};

test.describe("/ask page — anon flows (route-intercepted)", () => {
  test("renders the ask page with gubbe and input box", async ({ page }) => {
    await page.goto("/ask");

    await expect(page.getByAltText("Fiskargubben").first()).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Skriv din fråga till Fiskargubben" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Skicka fråga" }),
    ).toBeVisible();
  });

  test("streamed advice renders with signal badges; register gate on 2nd new chat", async ({
    page,
  }) => {
    let callCount = 0;

    await page.route("**/api/ask", async (route) => {
      callCount += 1;
      if (callCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          headers: {
            "X-Conversation-Id": "11111111-2222-4333-8444-555555555555",
            "X-Signals": encodeURIComponent(JSON.stringify(BADGES)),
          },
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

    // ── First prompt: advice + badges ──────────────────────────────────────
    await input.fill(FISHING_QUESTION);
    await submitBtn.click();

    await expect(page.getByText(CANNED_ADVICE)).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(FISHING_QUESTION)).toBeVisible();

    // Badges strip shows lake + conditions from the X-Signals header.
    const strip = page.locator('[aria-label="Fångad data"]');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("Vättern");
    await expect(strip).toContainText("m/s");

    // ── Second prompt: register CTA points at the auth dialog ─────────────
    await expect(input).toBeEnabled({ timeout: 8000 });
    await input.fill(SECOND_QUESTION);
    await submitBtn.click();

    const cta = page.getByRole("link", { name: "Logga in / skapa konto" });
    await expect(cta).toBeVisible({ timeout: 8000 });
    await expect(cta).toHaveAttribute("href", "/?auth=1");
  });

  test("clarify response renders as an in-persona bubble and the chat continues", async ({
    page,
  }) => {
    const CLARIFY = "Det finns flera Åsunden, hörru — vilken kommun menar du?";
    let callCount = 0;

    await page.route("**/api/ask", async (route) => {
      callCount += 1;
      if (callCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: {
            "X-Conversation-Id": "22222222-3333-4444-8555-666666666666",
          },
          body: JSON.stringify({ type: "clarify", text: CLARIFY }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          headers: {
            "X-Conversation-Id": "22222222-3333-4444-8555-666666666666",
          },
          body: CANNED_ADVICE,
        });
      }
    });

    await page.goto("/ask");

    const input = page.getByRole("textbox", {
      name: "Skriv din fråga till Fiskargubben",
    });
    const submitBtn = page.getByRole("button", { name: "Skicka fråga" });

    await input.fill("Vad biter i Åsunden?");
    await submitBtn.click();

    // Clarify question appears as an assistant bubble, input stays usable.
    await expect(page.getByText(CLARIFY)).toBeVisible({ timeout: 8000 });
    await expect(input).toBeEnabled();

    // Answering the clarify question continues into the streamed advice.
    await input.fill("Ulricehamn");
    await submitBtn.click();
    await expect(page.getByText(CANNED_ADVICE)).toBeVisible({ timeout: 8000 });
  });
});
