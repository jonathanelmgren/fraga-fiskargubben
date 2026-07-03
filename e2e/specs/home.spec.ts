import { expect, test } from "@playwright/test";

test("landing shows the chat-first hero", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Fråga gubben innan du kastar." }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Fråga Fiskargubben" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Fråga" })).toBeVisible();
  // No standalone signup button anywhere — only "Logga in".
  await expect(page.getByRole("button", { name: "Logga in" })).toBeVisible();
});

test("Logga in opens the auth dialog; link flips it to signup", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Logga in" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Logga in" })).toBeVisible();

  // Flip to signup
  await dialog.getByRole("button", { name: "Skapa konto här" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Skapa konto" }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Namn")).toBeVisible();

  // ...and back
  await dialog.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Logga in" })).toBeVisible();
});

test("old /register route redirects into the auth dialog", async ({ page }) => {
  await page.goto("/register");
  // Redirects to / and auto-opens the dialog (?auth=1 is consumed).
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("hero prompt hands off to /ask", async ({ page }) => {
  // Intercept so the auto-submitted prompt doesn't need a live backend.
  await page.route("**/api/ask", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers: { "X-Conversation-Id": "11111111-2222-4333-8444-555555555555" },
      body: "Testsvar från gubben.",
    });
  });

  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Fråga Fiskargubben" })
    .fill("Ska jag fiska i Tolken ikväll?");
  await page.getByRole("button", { name: "Fråga" }).click();

  await expect(page).toHaveURL(/\/ask/);
  // The pending prompt auto-submits and renders both bubbles.
  await expect(page.getByText("Ska jag fiska i Tolken ikväll?")).toBeVisible({
    timeout: 8000,
  });
  await expect(page.getByText("Testsvar från gubben.")).toBeVisible({
    timeout: 8000,
  });
});
