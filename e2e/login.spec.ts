import { expect, test } from "@playwright/test";
import { PASSWORD } from "./helpers";

// Fresh browser state: no session, and the language chosen per test.
test.use({ storageState: { cookies: [], origins: [] } });

for (const locale of ["en", "ar"] as const) {
  test(`password visibility toggle keeps the value, the focus and the form (${locale})`, async ({ page }) => {
    await page.context().addCookies([{ name: "ims_locale", value: locale, url: process.env.E2E_BASE_URL ?? "http://localhost:3000" }]);
    let submitted = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/auth/login")) submitted++;
    });
    await page.goto("/login");
    const password = page.locator('input[autocomplete="current-password"]');
    const show = page.getByRole("button", { name: locale === "en" ? "Show password" : "إظهار كلمة المرور" });

    await password.click();
    await password.pressSequentially("Secret-123");
    await expect(password).toHaveAttribute("type", "password");
    await expect(show).toHaveAttribute("aria-pressed", "false");

    // Show: the typed value appears as text, the field keeps the focus, nothing is submitted.
    await show.click();
    await expect(password).toHaveAttribute("type", "text");
    await expect(password).toHaveValue("Secret-123");
    await expect(password).toBeFocused();
    const hide = page.getByRole("button", { name: locale === "en" ? "Hide password" : "إخفاء كلمة المرور" });
    await expect(hide).toHaveAttribute("aria-pressed", "true");
    // Typing continues where the caret was (the end).
    await page.keyboard.type("4");
    await expect(password).toHaveValue("Secret-1234");

    // Hide again with the keyboard: Tab to the button, Space toggles it, the value stays.
    await page.keyboard.press("Tab");
    await expect(hide).toBeFocused();
    await page.keyboard.press("Space");
    await expect(password).toHaveAttribute("type", "password");
    await expect(password).toHaveValue("Secret-1234");
    // Enter on the button toggles it too, without submitting the form.
    await page.keyboard.press("Enter");
    await expect(password).toHaveAttribute("type", "text");
    expect(submitted).toBe(0);
    await expect(page).toHaveURL(/\/login/);

    // The icon sits inside the field on the side the field keeps free, not over the text.
    const field = await password.boundingBox();
    const button = await page.getByRole("button", { name: locale === "en" ? "Hide password" : "إخفاء كلمة المرور" }).boundingBox();
    expect(field && button).toBeTruthy();
    expect(button!.x + button!.width).toBeLessThanOrEqual(field!.x + field!.width + 1);
    expect(button!.x).toBeGreaterThan(field!.x + field!.width / 2);
    const padRight = await password.evaluate((el) => parseFloat(getComputedStyle(el).paddingRight));
    expect(padRight).toBeGreaterThanOrEqual(button!.width - 1);
  });
}

test("signing in still works after toggling the password", async ({ page }) => {
  await page.context().addCookies([{ name: "ims_locale", value: "en", url: process.env.E2E_BASE_URL ?? "http://localhost:3000" }]);
  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Show password" }).click();
  await page.getByRole("button", { name: "Hide password" }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await expect(page.locator("main h1").first()).toBeVisible();
});
