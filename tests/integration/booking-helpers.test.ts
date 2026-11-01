import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment, getAppointment, getAppointmentHistory, updateAppointment } from "@/server/services/appointments";
import { holdSlot, releaseHolds, suggestTechnicians } from "@/server/services/booking-helpers";
import { getRoute } from "@/server/services/car";
import { buildReport } from "@/server/services/reports";
import { previewQuote, saveQuote } from "@/server/services/quotes";
import { updateUser } from "@/server/services/users";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { addDaysToKey, computeEnd, todayKey, zonedToUtc } from "@/lib/time";
import { ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

const tz = DEFAULT_TIMEZONE;
const today = todayKey(tz);
const tomorrow = addDaysToKey(today, 1);
const yesterday = addDaysToKey(today, -1);
const quoteHtml = readFileSync(path.join(__dirname, "../fixtures/quote.html"), "utf8");

let server: Server;
let host = "";
beforeAll(async () => {
  // A stand-in for the company website: a quotation, a redirect elsewhere, a missing page.
  server = createServer((req, res) => {
    if (req.url === "/q/42") return void res.writeHead(200, { "content-type": "text/html" }).end(quoteHtml);
    if (req.url === "/moved") return void res.writeHead(302, { location: "/q/42" }).end();
    if (req.url === "/away") return void res.writeHead(302, { location: "http://example.org/q/42" }).end();
    res.writeHead(404).end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.QUOTE_HOSTS = host;
  process.env.QUOTE_ALLOW_HTTP = "1";
});
afterAll(async () => {
  delete process.env.QUOTE_HOSTS;
  delete process.env.QUOTE_ALLOW_HTTP;
  await new Promise((r) => server.close(r));
});

let admin: User, sales: User, otherSales: User, lockTech: User, smartTech: User, anyTech: User;
beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES", { name: "Sara Sales" });
  otherSales = await makeUser("SALES", { name: "Omar Sales" });
  lockTech = await makeUser("TECHNICIAN", { name: "Lock Tech" });
  smartTech = await makeUser("TECHNICIAN", { name: "Smart Tech" });
  anyTech = await makeUser("TECHNICIAN", { name: "Any Tech" });
  await updateUser(asCurrent(admin), lockTech.id, { specialty: "LOCK" });
  await updateUser(asCurrent(admin), smartTech.id, { specialty: "SMART_HOME" });
});

const payload = (o: Record<string, unknown> = {}) => appointmentPayload({ date: tomorrow, startTime: "10:00", durationMinutes: 60, ...o });

describe("booking rules", () => {
  it("lets only an Admin book a date that has passed, and leaves old bookings editable", async () => {
    await expect(createAppointment(asCurrent(sales), payload({ date: yesterday }))).rejects.toThrow(ValidationError);
    const old = await createAppointment(asCurrent(admin), payload({ date: yesterday, salesUserId: sales.id }));
    // Editing an old booking without moving it is fine; moving another one into the past is not.
    const edited = await updateAppointment(asCurrent(sales), old.id, payload({ date: yesterday, brand: "Yale", version: old.version }));
    expect(edited.brand).toBe("Yale");
    const future = await createAppointment(asCurrent(sales), payload({ startTime: "15:00" }));
    await expect(updateAppointment(asCurrent(sales), future.id, payload({ date: yesterday, startTime: "15:00", version: future.version }))).rejects.toThrow(ValidationError);
    expect((await createAppointment(asCurrent(sales), payload({ date: today, startTime: "23:00", durationMinutes: 15 }))).id).toBeTruthy();
  });

  it("keeps site readiness, lock location, electrician and the quotation link with their history", async () => {
    const a = await createAppointment(
      asCurrent(sales),
      payload({ productCategory: "SMART_HOME", siteFoundation: "NOT_READY", siteInternet: "READY", lockAt: "COMPANY", electrician: "NOT_NEEDED", quoteUrl: `http://${host}/q/42` }),
    );
    expect(a).toMatchObject({ siteFoundation: "NOT_READY", siteInternet: "READY", lockAt: "COMPANY", electrician: "NOT_NEEDED", quoteUrl: `http://${host}/q/42`, quote: null });
    const b = await updateAppointment(asCurrent(sales), a.id, payload({ productCategory: "SMART_HOME", siteFoundation: "READY", version: a.version }));
    expect(b).toMatchObject({ siteFoundation: "READY", siteInternet: "READY", lockAt: "COMPANY" });
    const history = await getAppointmentHistory(asCurrent(sales), a.id);
    expect(history[0]!.changes).toMatchObject({ siteFoundation: { from: "NOT_READY", to: "READY" } });
    await expect(createAppointment(asCurrent(sales), payload({ startTime: "16:00", lockAt: "ROOF" }))).rejects.toThrow(ValidationError);
    await expect(createAppointment(asCurrent(sales), payload({ startTime: "16:00", quoteUrl: "javascript:alert(1)" }))).rejects.toThrow(ValidationError);
  });
});

describe("slot holds", () => {
  it("holds technicians for 10 minutes against other Sales, releases them on booking, and lets an Admin book over them", async () => {
    const hold = await holdSlot(asCurrent(sales), { date: tomorrow, startTime: "10:00", durationMinutes: 60, technicianIds: [lockTech.id] });
    expect(hold).toMatchObject({ ok: true, technicianIds: [lockTech.id] });
    const minutes = (Date.parse(hold.ok ? hold.until! : "") - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);

    const taken = await holdSlot(asCurrent(otherSales), { date: tomorrow, startTime: "10:30", durationMinutes: 60, technicianIds: [lockTech.id] });
    expect(taken).toMatchObject({ ok: false, reason: expect.stringMatching(/^holds\.heldByOther/) });
    await expect(createAppointment(asCurrent(otherSales), payload({ technicianIds: [lockTech.id] }))).rejects.toThrow(/being held by Sara Sales/);
    // A different time is free.
    expect((await createAppointment(asCurrent(otherSales), payload({ startTime: "14:00", technicianIds: [lockTech.id] }))).id).toBeTruthy();

    const startsAt = zonedToUtc(tomorrow, "10:00", tz);
    const seen = await suggestTechnicians(asCurrent(otherSales), { startsAt, endsAt: computeEnd(startsAt, 60), here: null, available: { [lockTech.id]: true } });
    expect(seen[lockTech.id]).toMatchObject({ heldBy: { name: "Sara Sales" }, suggested: false });

    await createAppointment(asCurrent(sales), payload({ technicianIds: [lockTech.id] }));
    expect(await prisma.slotHold.count()).toBe(0);

    await holdSlot(asCurrent(sales), { date: tomorrow, startTime: "18:00", durationMinutes: 60, technicianIds: [smartTech.id] });
    expect((await createAppointment(asCurrent(admin), payload({ startTime: "18:00", technicianIds: [smartTech.id] }))).id).toBeTruthy();
    await releaseHolds(asCurrent(sales));
    expect(await prisma.slotHold.count()).toBe(0);
  });

  it("refuses to hold a technician who is already booked and ignores expired holds", async () => {
    await createAppointment(asCurrent(sales), payload({ technicianIds: [anyTech.id] }));
    expect(await holdSlot(asCurrent(otherSales), { date: tomorrow, startTime: "10:30", durationMinutes: 30, technicianIds: [anyTech.id] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^holds\.booked/),
    });
    await holdSlot(asCurrent(sales), { date: tomorrow, startTime: "12:00", durationMinutes: 60, technicianIds: [smartTech.id] });
    await prisma.slotHold.updateMany({ data: { expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 20 * 60_000) } });
    expect((await createAppointment(asCurrent(otherSales), payload({ startTime: "12:00", technicianIds: [smartTech.id] }))).id).toBeTruthy();
  });
});

describe("technician suggestion (Aura api_free)", () => {
  it("prefers the right specialty, a lighter day and a neighbouring visit close by", async () => {
    // Smart Tech has a visit nearby in the period before; Any Tech has a far one.
    const near = { latitude: "30.0600", longitude: "31.3400" }; // Nasr City
    const far = { latitude: "29.9600", longitude: "30.9300" }; // 6th of October
    await createAppointment(asCurrent(sales), payload({ startTime: "11:00", technicianIds: [smartTech.id], location: { area: "Nasr City", ...near } }));
    await createAppointment(asCurrent(sales), payload({ startTime: "11:00", technicianIds: [anyTech.id], location: { area: "October", ...far } }));
    const startsAt = zonedToUtc(tomorrow, "14:30", tz);
    const q = { startsAt, endsAt: computeEnd(startsAt, 60), here: { lat: 30.065, lng: 31.345 }, available: { [lockTech.id]: true, [smartTech.id]: true, [anyTech.id]: true } };
    const smart = await suggestTechnicians(asCurrent(sales), { ...q, category: "SMART_HOME" });
    expect(smart[lockTech.id]).toMatchObject({ fits: false, score: null, suggested: false });
    expect(smart[smartTech.id]).toMatchObject({ fits: true, score: 8 - 15, suggested: true, dayVisits: 1 });
    expect(smart[anyTech.id]).toMatchObject({ fits: true, score: 8 + 40, suggested: true });
    const lock = await suggestTechnicians(asCurrent(sales), { ...q, category: "SMART_LOCK", available: { ...q.available, [lockTech.id]: false } });
    expect(lock[lockTech.id]!.suggested).toBe(false);
    expect(lock[smartTech.id]!.fits).toBe(false);
  });
});

describe("quotation link (Aura api_quote)", () => {
  it("reads quotations only from the allowed host, follows its own redirects and hides prices from technicians", async () => {
    const preview = await previewQuote(asCurrent(sales), { url: `http://${host}/moved` });
    expect(preview).toMatchObject({ number: "AURA-Q-2610-0042", count: 3, total: "20,150" });
    await expect(previewQuote(asCurrent(sales), { url: "https://evil.example/q" })).rejects.toThrow(/Only quotation links/);
    await expect(previewQuote(asCurrent(sales), { url: `http://${host}/away` })).rejects.toThrow(/Only quotation links/);
    await expect(previewQuote(asCurrent(sales), { url: `http://${host}/missing` })).rejects.toThrow(/error 404/);
    await expect(previewQuote(asCurrent(lockTech), { url: `http://${host}/q/42` })).rejects.toThrow();

    const a = await createAppointment(asCurrent(sales), payload({ technicianIds: [lockTech.id], quoteUrl: `http://${host}/q/42` }));
    await saveQuote(asCurrent(sales), a.id, { url: `http://${host}/q/42` });
    expect((await getAppointment(asCurrent(sales), a.id)).quote).toMatchObject({ total: "20,150", items: [expect.objectContaining({ unit: "8,500" }), expect.anything()] });
    const forTech = (await getAppointment(asCurrent(lockTech), a.id)).quote!;
    expect(forTech.total).toBeUndefined();
    expect(forTech.items[0]).toEqual({ name: "Philips 9300 Smart Lock", qty: 2, spec: "Face ID", sku: "PH-9300" });
    // A new link drops what was read from the old one.
    const fresh = await getAppointment(asCurrent(sales), a.id);
    const changed = await updateAppointment(asCurrent(sales), a.id, payload({ technicianIds: [lockTech.id], quoteUrl: `http://${host}/q/43`, version: fresh.version }));
    expect(changed.quote).toBeNull();
  });
});

describe("area centres and reports by area", () => {
  it("orders car stops without a pin by their area's centre and counts appointments by area", async () => {
    const withCompany = { companyLatitude: 30.0444, companyLongitude: 31.2357 };
    const far = await createAppointment(asCurrent(sales), payload({ date: today, startTime: "23:00", durationMinutes: 15, needsCar: true, location: { area: "Sheikh Zayed" } }));
    const near = await createAppointment(asCurrent(sales), payload({ date: today, startTime: "23:15", durationMinutes: 15, needsCar: true, location: { area: "وسط البلد" } }));
    const route = await getRoute(asCurrent(admin, withCompany));
    expect(route.stops.map((s) => s.id)).toEqual([near.id, far.id]);
    const report = await buildReport(asCurrent(admin), { from: today, to: today });
    expect(report.byArea.map((r) => r.area).sort()).toEqual(["Sheikh Zayed", "وسط البلد"].sort());
  });
});
