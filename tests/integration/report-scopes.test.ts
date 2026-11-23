/**
 * Reports and their CSV exports follow the reader's appointment scope (audit M1): nothing outside
 * it shows up in totals, status/sales counts, technician workload, daily totals, areas or exported
 * rows. ALL readers keep seeing everything.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment } from "@/server/services/appointments";
import { buildReport, reportCsv } from "@/server/services/reports";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

const RANGE = { from: "2030-03-01", to: "2030-03-31" };
const SETTINGS = { salesCanViewReports: true };
let admin: User, salesA: User, salesB: User, salesC: User, nobody: User, tech1: User, tech2: User;

/** A Sales user with an appointment scope (and the export right). */
async function scoped(u: User, scope: "OWN" | "TEAM" | "ALL") {
  const row = await prisma.user.update({ where: { id: u.id }, data: { dataScopes: { appointments: scope }, permissionGrants: ["reports.export"] } });
  return asCurrent(row, SETTINGS);
}

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  const team = await prisma.team.create({ data: { name: "North" } });
  admin = await makeUser("ADMIN");
  salesA = await makeUser("SALES", { name: "Sales A" });
  salesB = await makeUser("SALES", { name: "Sales B" });
  salesC = await makeUser("SALES", { name: "Sales C" });
  nobody = await makeUser("SALES", { name: "Sales None" });
  await prisma.user.updateMany({ where: { id: { in: [salesA.id, salesB.id] } }, data: { teamId: team.id } });
  [salesA, salesB] = await Promise.all([salesA, salesB].map((u) => prisma.user.findUniqueOrThrow({ where: { id: u.id } })));
  tech1 = await makeUser("TECHNICIAN", { name: "Tech One" });
  tech2 = await makeUser("TECHNICIAN", { name: "Tech Two" });
  // Sales cannot assign technicians by default; book as the admin on their behalf.
  const asAdminFor = (u: User, date: string, tech: User, area: string, customer: string) =>
    createAppointment(
      asCurrent(admin, SETTINGS),
      appointmentPayload({ salesUserId: u.id, date, technicianIds: [tech.id], customer: { name: customer, phone: "+20 100 000 0000", secondaryPhone: "" }, location: { ...appointmentPayload().location, area } }),
    );
  await asAdminFor(salesA, "2030-03-10", tech1, "Zamalek", "Customer Alpha");
  await asAdminFor(salesB, "2030-03-11", tech1, "Maadi", "Customer Beta");
  await asAdminFor(salesC, "2030-03-12", tech2, "Heliopolis", "Customer Gamma");
});

const summary = (r: Awaited<ReturnType<typeof buildReport>>) => ({
  total: r.total,
  // Ties have no defined order: compare as sorted lists.
  bySales: r.bySales.map((s) => [s.name, s.count]).sort(),
  byStatus: r.byStatus.reduce((n, s) => n + s.count, 0),
  byCategory: r.byCategory.reduce((n, c) => n + c.count, 0),
  byTechnician: r.byTechnician.map((t) => [t.name, t.jobs]).sort(),
  daily: r.daily.map((d) => [d.day, d.count]),
  byArea: r.byArea.map((a) => [a.area, a.count]).sort(),
});

describe("report scopes", () => {
  it("ALL: every appointment, as before", async () => {
    expect(summary(await buildReport(asCurrent(admin), RANGE))).toEqual({
      total: 3,
      bySales: [["Sales A", 1], ["Sales B", 1], ["Sales C", 1]],
      byStatus: 3,
      byCategory: 3,
      byTechnician: [["Tech One", 2], ["Tech Two", 1]],
      daily: [["2030-03-10", 1], ["2030-03-11", 1], ["2030-03-12", 1]],
      byArea: [["Heliopolis", 1], ["Maadi", 1], ["Zamalek", 1]],
    });
    expect(summary(await buildReport(await scoped(salesC, "ALL"), RANGE)).total).toBe(3);
  });

  it("TEAM: only the team's appointments, in every figure", async () => {
    expect(summary(await buildReport(await scoped(salesA, "TEAM"), RANGE))).toEqual({
      total: 2,
      bySales: [["Sales A", 1], ["Sales B", 1]],
      byStatus: 2,
      byCategory: 2,
      byTechnician: [["Tech One", 2]],
      daily: [["2030-03-10", 1], ["2030-03-11", 1]],
      byArea: [["Maadi", 1], ["Zamalek", 1]],
    });
  });

  it("OWN: only the reader's own appointments, in every figure", async () => {
    expect(summary(await buildReport(await scoped(salesA, "OWN"), RANGE))).toEqual({
      total: 1,
      bySales: [["Sales A", 1]],
      byStatus: 1,
      byCategory: 1,
      byTechnician: [["Tech One", 1]],
      daily: [["2030-03-10", 1]],
      byArea: [["Zamalek", 1]],
    });
  });

  it("no permitted appointments: every figure empty", async () => {
    const r = await buildReport(await scoped(nobody, "OWN"), RANGE);
    expect(summary(r)).toEqual({ total: 0, bySales: [], byStatus: 0, byCategory: 0, byTechnician: [], daily: [], byArea: [] });
    // Without appointments.view at all: nothing either.
    const viewer = await makeUser("VIEWER", { viewerPermissions: ["reports.view"] });
    expect(summary(await buildReport(asCurrent(viewer), RANGE)).total).toBe(0);
  });

  it("CSV exports contain exactly what the report shows", async () => {
    const own = await scoped(salesA, "OWN");
    const rows = (csv: string) => csv.replace(/^﻿/, "").trim().split("\r\n").slice(1);
    expect(rows(await reportCsv(own, "daily", RANGE))).toEqual(["2030-03-10,1"]);
    expect(rows(await reportCsv(own, "technicians", RANGE))).toEqual(["Tech One,Yes,1,2.0,0,0"]);
    expect(rows(await reportCsv(own, "sales", RANGE))).toEqual(["Sales A,Yes,1"]);
    const all = await reportCsv(own, "appointments", RANGE);
    expect(rows(all)).toHaveLength(1);
    expect(all).toContain("Customer Alpha");
    for (const outside of ["Customer Beta", "Customer Gamma", "Maadi", "Heliopolis", "Tech Two"]) expect(all).not.toContain(outside);

    const team = await scoped(salesA, "TEAM");
    expect(rows(await reportCsv(team, "daily", RANGE))).toEqual(["2030-03-10,1", "2030-03-11,1"]);
    expect(rows(await reportCsv(team, "appointments", RANGE))).toHaveLength(2);
    expect(rows(await reportCsv(asCurrent(admin), "technicians", RANGE))).toEqual(["Tech One,Yes,2,4.0,0,0", "Tech Two,Yes,1,2.0,0,0"]);
  });

  it("other people's appointments cannot be reached by widening the date range", async () => {
    const r = await buildReport(await scoped(salesB, "OWN"), { from: "2000-01-01", to: "2099-12-31" });
    expect(summary(r)).toMatchObject({ total: 1, daily: [["2030-03-11", 1]], byArea: [["Maadi", 1]], byTechnician: [["Tech One", 1]] });
  });
});
