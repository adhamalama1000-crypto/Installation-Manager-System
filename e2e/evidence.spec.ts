import { expect, test, type APIRequestContext } from "@playwright/test";
import { futureDate, login, PASSWORD, technicianIds } from "./helpers";

// 16×16 orange PNG: a real image the browser can decode and shrink before upload.
const PHOTO = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGN4GqFMEmIY1TCqYfhqAADkpWAQ+m/KkwAAAABJRU5ErkJggg==", "base64");
// The first bytes of an MP4 file (an "ftyp" box): the server checks the type from these.
const VIDEO = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2avc1mp41"), Buffer.alloc(64)]);

/**
 * Work evidence through the real UI: the Admin sets a rule for programming visits of intercoms
 * (photo, video, customer confirmation, review); "Done" is refused until the technician adds them;
 * the Admin sends the work back with a reason, the technician submits it again, the Admin approves.
 * The rule is switched off at the end so other specs' visits are not held to it.
 */
const RULE = { visitType: "PROGRAMMING", productCategory: "INTERCOM" };
let admin: APIRequestContext;

test.afterAll(async () => {
  await admin?.put("/api/evidence/rules", { data: { ...RULE, minAfterPhotos: 1, requireVideo: true, requireCustomerConfirmation: true, requireReview: true, isActive: false } });
  await admin?.dispose();
});

test("evidence is required before done, then reviewed, sent back, resubmitted and approved", async ({ page, browser, playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  admin = await playwright.request.newContext({ baseURL });
  await admin.post("/api/auth/login", { data: { email: "admin@example.com", password: PASSWORD } });

  // The Admin sets the rule in Settings.
  const adminPage = await (await browser.newContext()).newPage();
  await login(adminPage, "admin@example.com");
  await adminPage.goto("/settings");
  await adminPage.getByRole("button", { name: "Add rule" }).click();
  const dialog = adminPage.getByRole("dialog", { name: "Add rule" });
  await dialog.getByLabel("Visit type").selectOption(RULE.visitType);
  await dialog.getByLabel("Product category").selectOption(RULE.productCategory);
  await dialog.getByLabel("Before photos (at least)").fill("0");
  await dialog.getByLabel("After photos (at least)").fill("1");
  await dialog.getByLabel("A video of the work").check();
  await dialog.getByLabel("The customer's confirmation").check();
  await dialog.getByLabel("A manager reviews and approves the work").check();
  await dialog.getByLabel("Active").check();
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await expect(dialog).toBeHidden();
  await expect(adminPage.getByText("after: 1 photo · video · confirmation · review")).toBeVisible();

  // A programming visit of an intercom for Ahmed.
  const sales = await playwright.request.newContext({ baseURL });
  await sales.post("/api/auth/login", { data: { email: "sara.sales@example.com", password: PASSWORD } });
  const ahmed = (await technicianIds(sales)).find((t) => t.name === "Ahmed Samir")!;
  const created = await sales.post("/api/appointments", {
    data: {
      customer: { name: `E2E Evidence ${Date.now()}`, phone: "+20 100 555 0188" },
      location: { area: "Maadi" },
      productCategory: RULE.productCategory,
      visitType: RULE.visitType,
      date: futureDate(240),
      startTime: "11:00",
      durationMinutes: 60,
      technicianIds: [ahmed.id],
    },
  });
  expect(created.status()).toBe(201);
  const { appointment } = await created.json();
  await sales.dispose();

  // The technician cannot mark it done yet: the outcome lists what is missing.
  await login(page, "ahmed.tech@example.com");
  await page.goto(`/appointments/${appointment.id}`);
  await expect(page.getByRole("heading", { name: "Work evidence" })).toBeVisible();
  await expect(page.getByText("After photos: 0 of 1")).toBeVisible();
  await page.getByRole("radio", { name: "Done" }).click();
  await page.getByLabel("Visit report").fill("Intercom programmed, all units ring.");
  await page.getByRole("button", { name: "Save outcome" }).click();
  await expect(page.getByText("1 more after photo").first()).toBeVisible();
  await expect(page.getByText("A video of the work").first()).toBeVisible();

  // Photo and video, then done with the customer's confirmation.
  const after = page.locator('section[aria-labelledby="att-AFTER_PHOTO"]');
  await after.locator('input[type="file"]').setInputFiles({ name: "panel.png", mimeType: "image/png", buffer: PHOTO });
  await expect(after.locator("img")).toHaveCount(1);
  const videos = page.locator('section[aria-labelledby="att-VIDEO"]');
  await videos.locator('input[type="file"]').setInputFiles({ name: "test.mp4", mimeType: "video/mp4", buffer: VIDEO });
  await expect(videos.locator("video")).toHaveCount(1);
  await expect(page.getByText("All the required evidence is in.")).toBeVisible();
  await page.getByLabel("The customer confirmed the work").check();
  await page.getByLabel("Name of who confirmed (optional)").fill("Hany");
  await page.getByRole("button", { name: "Save outcome" }).click();
  await expect(page.getByTestId("evidence-status")).toHaveText("Waiting for review");

  // The video is served in ranges, to signed-in readers only.
  const src = (await videos.locator("video").getAttribute("src"))!;
  const part = await admin.get(src, { headers: { Range: "bytes=0-7" } });
  expect(part.status()).toBe(206);
  expect(part.headers()["content-range"]).toBe(`bytes 0-7/${VIDEO.byteLength}`);
  expect(part.headers()["content-type"]).toBe("video/mp4");
  expect((await part.body()).subarray(4, 8).toString()).toBe("ftyp");
  const anonymous = await (await browser.newContext()).request.get(src);
  expect(anonymous.status()).toBe(401);

  // The Admin finds it in the review queue and sends it back with the reason.
  await adminPage.goto("/evidence");
  await adminPage.getByRole("link", { name: appointment.code }).click();
  await adminPage.getByRole("button", { name: "Send back" }).click();
  const back = adminPage.getByRole("dialog", { name: "Send the work back" });
  await back.getByRole("button", { name: "Send back" }).click();
  await expect(back.getByText("Say why the work is sent back.")).toBeVisible();
  await back.getByLabel("Reason").fill("Show the outdoor unit too.");
  await back.getByRole("button", { name: "Send back" }).click();
  await expect(back).toBeHidden();
  await expect(adminPage.getByTestId("evidence-status")).toHaveText("Sent back for correction");

  // The technician sees why, adds a photo and submits again.
  await page.reload();
  await expect(page.getByText("Show the outdoor unit too.").first()).toBeVisible();
  await after.locator('input[type="file"]').setInputFiles({ name: "outdoor.png", mimeType: "image/png", buffer: PHOTO });
  await expect(after.locator("img")).toHaveCount(2);
  await page.getByRole("button", { name: "Submit again" }).click();
  const again = page.getByRole("dialog", { name: "Submit the corrected work" });
  await again.getByLabel("The customer confirmed the work").check();
  await again.getByRole("button", { name: "Submit again" }).click();
  await expect(again).toBeHidden();
  await expect(page.getByTestId("evidence-status")).toHaveText("Waiting for review");

  // The Admin approves; the history shows every step.
  await adminPage.reload();
  await adminPage.getByRole("button", { name: "Approve" }).click();
  const approve = adminPage.getByRole("dialog", { name: "Approve the work" });
  await approve.getByRole("button", { name: "Approve" }).click();
  await expect(approve).toBeHidden();
  await expect(adminPage.getByTestId("evidence-status")).toHaveText("Approved");
  await expect(adminPage.getByText(/approved the work$/)).toBeVisible();
  await expect(adminPage.getByText(/sent the work back$/)).toBeVisible();
  await adminPage.goto("/evidence?status=APPROVED");
  await expect(adminPage.getByRole("link", { name: appointment.code })).toBeVisible();
});
