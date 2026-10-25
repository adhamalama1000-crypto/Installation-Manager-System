import "server-only";
import { CONFIRMATION_LABELS, VISIT_TYPE_LABELS, appointmentCode } from "@/lib/constants";
import { customerReminder, technicianMessage, whatsappLink, type PlanVisit } from "@/lib/day-plan";
import { productLine } from "@/lib/format";
import { resolveLocationLink } from "@/lib/maps";
import { dayRangeUtc, fmt, formatKey } from "@/lib/time";
import { prisma } from "../db";
import { appointmentScope, assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { amountDue } from "./payments";

export type DayPlanVisit = PlanVisit & {
  id: string;
  status: { name: string; color: string };
  confirmation: string;
  confirmed: boolean;
  reminderLink: string | null;
};

/**
 * Aura's day plan: per technician, the visits of one day as a ready-to-send WhatsApp message, plus
 * a reminder link for each customer. Cancelled and postponed visits are left out.
 */
export async function dayPlan(user: CurrentUser, date: string) {
  assertCan(user, "appointments.manage");
  const tz = user.settings.timezone;
  const range = dayRangeUtc(date, date, tz);
  const rows = await prisma.appointment.findMany({
    where: {
      AND: [appointmentScope(user), { startsAt: { gte: range.start, lt: range.end } }, { status: { kind: { notIn: ["CANCELLED", "POSTPONED"] } } }],
    },
    select: {
      id: true,
      number: true,
      startsAt: true,
      endsAt: true,
      productCategory: true,
      categoryOther: true,
      visitType: true,
      brand: true,
      model: true,
      requiredEquipment: true,
      additionalNotes: true,
      customerConfirmation: true,
      totalPrice: true,
      depositAmount: true,
      extraFee: true,
      collectedAmount: true,
      status: { select: { name: true, color: true } },
      customer: { select: { name: true, phone: true } },
      location: { select: { area: true, building: true, streetAddress: true, apartment: true, floor: true, mapUrl: true, latitude: true, longitude: true } },
      technicians: { select: { technician: { select: { id: true, name: true, phone: true } } }, orderBy: { technician: { name: "asc" } } },
    },
    orderBy: [{ startsAt: "asc" }, { number: "asc" }],
  });

  const dayLabel = formatKey(date, { weekday: "long", day: "numeric", month: "long" });
  const company = user.settings.companyName || "your installation team";

  const visit = (a: (typeof rows)[number], forTechnician?: string): DayPlanVisit => {
    const l = a.location;
    const due = amountDue(a);
    const time = `${fmt(a.startsAt, tz, "HH:mm")}–${fmt(a.endsAt, tz, "HH:mm")}`;
    const what = productLine(a);
    return {
      id: a.id,
      code: appointmentCode(a.number),
      time,
      what,
      customerName: a.customer.name,
      customerPhone: a.customer.phone,
      address: [l.area, l.building, l.streetAddress, l.apartment && `Apt ${l.apartment}`, l.floor && `Floor ${l.floor}`].filter(Boolean).join(", "),
      mapLink: resolveLocationLink({ mapUrl: l.mapUrl, latitude: l.latitude?.toNumber() ?? null, longitude: l.longitude?.toNumber() ?? null }),
      equipment: a.requiredEquipment,
      notes: a.additionalNotes,
      // What is still to be collected (nothing once a collection is recorded).
      toCollect: due !== null && a.collectedAmount === null ? due : null,
      withOthers: a.technicians.map((t) => t.technician.name).filter((n) => n !== forTechnician),
      status: a.status,
      confirmation: CONFIRMATION_LABELS[a.customerConfirmation],
      confirmed: a.customerConfirmation === "CONFIRMED",
      reminderLink: a.customer.phone
        ? whatsappLink(a.customer.phone, customerReminder(a.customer.name, dayLabel, fmt(a.startsAt, tz, "HH:mm"), a.visitType ? VISIT_TYPE_LABELS[a.visitType] : "installation", company))
        : null,
    };
  };

  const byTech = new Map<string, { id: string; name: string; phone: string | null; visits: DayPlanVisit[] }>();
  const unassigned: DayPlanVisit[] = [];
  for (const a of rows) {
    if (!a.technicians.length) unassigned.push(visit(a));
    for (const { technician: t } of a.technicians) {
      const entry = byTech.get(t.id) ?? { id: t.id, name: t.name, phone: t.phone, visits: [] };
      entry.visits.push(visit(a, t.name));
      byTech.set(t.id, entry);
    }
  }
  const technicians = [...byTech.values()]
    .sort((x, y) => x.name.localeCompare(y.name))
    .map((t) => {
      const message = technicianMessage(t.name, dayLabel, t.visits);
      return { ...t, message, link: whatsappLink(t.phone, message) };
    });
  return { date, dayLabel, visits: rows.length, technicians, unassigned };
}
