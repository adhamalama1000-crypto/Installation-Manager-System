import { expect, test, type APIRequestContext } from "@playwright/test";
import { login, PASSWORD } from "./helpers";

/**
 * Violations through the real UI: the Admin adds a rule and records a deduction for Ahmed (only
 * proposed), approves it; finance lists the approved deduction; Ahmed sees it on his own page; the
 * Admin cancels it with a reason and finance reverses it. The rule is switched off at the end.
 */
const STAMP = Date.now();
const RULE = `E2E uniform ${STAMP}`;
const WHAT = `E2E broken drill ${STAMP}`;
let admin: APIRequestContext;

test.afterAll(async () => {
  if (!admin) return;
  const { rules } = await (await admin.get("/api/penalties/rules")).json();
  const r = rules.find((x: { name: string }) => x.name === RULE);
  if (r) await admin.patch(`/api/penalties/rules/${r.id}`, { data: { ...r, isActive: false } });
  await admin.dispose();
});

test("a deduction is proposed, approved, reaches finance, is seen by the employee, and is cancelled with a reason", async ({ page, browser, playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  admin = await playwright.request.newContext({ baseURL });
  await admin.post("/api/auth/login", { data: { email: "admin@example.com", password: PASSWORD } });

  await login(page, "admin@example.com");
  // A rule for violations recorded by hand.
  await page.goto("/penalties/rules");
  await page.getByRole("button", { name: "Add rule" }).click();
  const ruleDialog = page.getByRole("dialog", { name: "Add rule" });
  await ruleDialog.getByRole("textbox", { name: "Name", exact: true }).fill(RULE);
  await ruleDialog.getByLabel("When").selectOption("MANUAL");
  await ruleDialog.getByLabel("Penalty").selectOption("FIXED");
  await ruleDialog.getByRole("button", { name: "Save" }).click();
  await expect(ruleDialog.getByText("Enter an amount above zero.")).toBeVisible();
  await ruleDialog.getByLabel("Amount (EGP)").fill("75");
  await ruleDialog.getByRole("button", { name: "Save" }).click();
  await expect(ruleDialog).toBeHidden();
  await expect(page.getByRole("listitem").filter({ hasText: RULE })).toContainText("Recorded by hand");

  // Recorded by hand: only proposed.
  await page.goto("/penalties");
  await page.getByRole("button", { name: "Record violation" }).click();
  const rec = page.getByRole("dialog", { name: "Record a violation" });
  await rec.getByRole("combobox", { name: "Employee" }).fill("Ahmed");
  await page.getByRole("option", { name: "Ahmed Samir, Technician" }).click();
  await rec.getByLabel("Rule").selectOption({ label: RULE });
  // The rule fills in its penalty.
  await expect(rec.getByLabel("Penalty")).toHaveValue("DEDUCTION");
  await expect(rec.getByLabel("Amount (EGP)")).toHaveValue("75");
  await rec.getByLabel("What happened").fill(WHAT);
  await rec.getByRole("button", { name: "Save" }).click();
  await expect(rec).toBeHidden();
  const row = page.locator("tbody tr").filter({ hasText: WHAT });
  await expect(row).toContainText("Waiting for approval");
  await expect(row).toContainText("Ahmed Samir");

  // Approved with a lower amount.
  await row.getByRole("button", { name: /^Approve VIO-/ }).click();
  const approve = page.getByRole("dialog", { name: /^Approve violation/ });
  await approve.getByLabel("Amount (EGP)").fill("60");
  await approve.getByLabel("Note (optional)").fill("First time");
  await approve.getByRole("button", { name: "Approve" }).click();
  await expect(approve).toBeHidden();
  await page.goto("/penalties?status=APPROVED");
  const approved = page.locator("tbody tr").filter({ hasText: WHAT });
  await expect(approved).toContainText("Approved");
  await expect(approved).toContainText(/Deduction of .*60/);
  const number = (await approved.getByRole("link").first().textContent())!.trim();

  // Finance lists the approved deduction for this month.
  await page.goto("/finance");
  const deductions = page.getByRole("list", { name: "Approved deductions" });
  await expect(deductions).toContainText("Ahmed Samir");

  // Ahmed sees it on his own page, without anyone else's.
  const tech = await (await browser.newContext()).newPage();
  await login(tech, "ahmed.tech@example.com");
  await tech.goto("/penalties/mine");
  await expect(tech.getByRole("heading", { level: 1, name: "My violations" })).toBeVisible();
  await expect(tech.locator("tbody tr").filter({ hasText: WHAT })).toContainText("Approved");
  await expect(tech.getByRole("button", { name: /^Cancel VIO-/ })).toHaveCount(0);
  await tech.goto("/penalties");
  await expect(tech).toHaveURL(/\/access-denied/);

  // Cancelled with the reason: the deduction is reversed in finance; the record stays.
  await page.goto("/penalties?status=APPROVED");
  await page.locator("tbody tr").filter({ hasText: WHAT }).getByRole("button", { name: `Cancel ${number}` }).click();
  const cancel = page.getByRole("dialog", { name: `Cancel violation ${number}` });
  await cancel.getByRole("button", { name: "Cancel" }).click();
  await expect(cancel.getByText("Say why it is cancelled.")).toBeVisible();
  await cancel.getByLabel("Reason").fill("The drill was already broken");
  await cancel.getByRole("button", { name: "Cancel" }).click();
  await expect(cancel).toBeHidden();
  await page.goto("/penalties?status=CANCELLED");
  await page.locator("tbody tr").filter({ hasText: WHAT }).getByRole("link", { name: number }).click();
  await expect(page.getByText("Deducted")).toBeVisible();
  await expect(page.getByText("Reversed")).toBeVisible();
  await expect(page.getByText(/cancelled it/)).toBeVisible();
  await tech.goto("/penalties/mine");
  await expect(tech.locator("tbody tr").filter({ hasText: WHAT })).toContainText("Cancelled");
});
