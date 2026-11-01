import { expect, test } from "@playwright/test";
import { futureDate, login, PASSWORD, technicianIds } from "./helpers";

// 16×16 orange PNG: a real image the browser can decode and shrink before upload.
const PHOTO = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGN4GqFMEmIY1TCqYfhqAADkpWAQ+m/KkwAAAABJRU5ErkJggg==", "base64");

test("the technician ticks the delivery checklist, adds an after photo and the customer's signature", async ({ page, playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  const sales = await playwright.request.newContext({ baseURL });
  await sales.post("/api/auth/login", { data: { email: "sara.sales@example.com", password: PASSWORD } });
  const ahmed = (await technicianIds(sales)).find((t) => t.name === "Ahmed Samir")!;
  const created = await sales.post("/api/appointments", {
    data: {
      customer: { name: `E2E Delivery ${Date.now()}`, phone: "+20 100 555 0177" },
      location: { area: "Sheikh Zayed" },
      productCategory: "SMART_LOCK",
      visitType: "INSTALLATION",
      date: futureDate(230),
      startTime: "13:00",
      durationMinutes: 90,
      technicianIds: [ahmed.id],
    },
  });
  expect(created.status()).toBe(201);
  const { appointment } = await created.json();

  await login(page, "ahmed.tech@example.com");
  await page.goto(`/appointments/${appointment.id}`);
  await expect(page.getByRole("heading", { name: "Photos and proofs" })).toBeVisible();

  // Checklist: four items for a smart lock, saved on each tick.
  for (const label of [/Fingerprint, code, card and key/, /App linked/, /Mechanical keys/, /Door locks and opens/]) {
    await page.getByLabel(label).check();
  }
  await expect(page.getByText("4 of 4")).toBeVisible();

  // After photo: picked from the phone, shrunk in the browser, shown as a thumbnail.
  const after = page.locator('section[aria-labelledby="att-AFTER_PHOTO"]');
  await after.locator('input[type="file"]').setInputFiles({ name: "door.png", mimeType: "image/png", buffer: PHOTO });
  await expect(after.locator("img")).toHaveCount(1);
  await expect(after.getByText("1 of 20")).toBeVisible();

  // Signature: an empty box is refused, a drawn one is saved.
  const signature = page.locator('section[aria-labelledby="att-SIGNATURE"]');
  await signature.getByRole("button", { name: "Sign" }).click();
  const dialog = page.getByRole("dialog", { name: "Customer signature" });
  await dialog.getByRole("button", { name: "Save signature" }).click();
  await expect(dialog.getByText("The box is empty")).toBeVisible();
  const box = (await dialog.locator("canvas").boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 40, { steps: 8 });
  await page.mouse.move(box.x + box.width - 30, box.y + box.height - 40, { steps: 8 });
  await page.mouse.up();
  await dialog.getByRole("button", { name: "Save signature" }).click();
  await expect(dialog).toBeHidden();
  await expect(signature.locator("img")).toHaveCount(1);
  await expect(signature.getByRole("button", { name: "Sign again" })).toBeVisible();

  // Sales sees the same files and the ticked checklist.
  const files = await (await sales.get(`/api/appointments/${appointment.id}/attachments`)).json();
  expect(files.items.map((i: { kind: string }) => i.kind)).toEqual(["AFTER_PHOTO", "SIGNATURE"]);
  const photo = await sales.get(files.items[0].url);
  expect(photo.headers()["content-type"]).toBe("image/jpeg");
  const seen = await (await sales.get(`/api/appointments/${appointment.id}`)).json();
  expect(seen.appointment.deliveryChecklist).toHaveLength(4);
  await sales.dispose();
});
