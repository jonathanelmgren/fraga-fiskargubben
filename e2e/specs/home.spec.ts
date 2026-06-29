import { expect, test } from "@playwright/test";

test("home page shows auth entry points when signed out", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Create account" }),
  ).toBeVisible();
});

test("register page renders the open-registration form", async ({ page }) => {
  await page.goto("/register");
  await expect(
    page.getByRole("heading", { name: "Create account" }),
  ).toBeVisible();
  await expect(page.getByText("Open registration")).toBeVisible();
});
