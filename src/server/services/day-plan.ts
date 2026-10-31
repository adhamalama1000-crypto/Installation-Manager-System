import "server-only";
import { createT } from "@/i18n/translator";
import { appointmentCode } from "@/lib/constants";
import { customerReminder, technicianMessage, whatsappLink, type PlanVisit } from "@/lib/day-plan";
import { productLine, statusName } from "@/lib/format";
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
      status: { select: { name: true, nameAr: true, color: true } },
      customer: { select: { name: true, phone: true } },
      location: { select: { area: true, building: true, streetAddress: true, apartment: true, floor: true, mapUrl: true, latitude: true, longitude: true } },
      technicians: { select: { technician: { select: { id: true, name: true, phone: true } } }, orderBy: { technician: { name: "asc" } } },
    },
    orderBy: [{ startsAt: "asc" }, { number: "asc" }],
  });

  const t = createT(user.locale);
  const dayLabel = formatKey(date, { weekday: "long", day: "numeric", month: "long" }, user.locale);
  const company = user.settings.companyName || t("dayPlanText.defaultCompany");

  const visit = (a: (typeof rows)[number], forTechnician?: string): DayPlanVisit => {
    const l = a.location;
    const due = amountDue(a);
    const time = `${fmt(a.startsAt, tz, "HH:mm")}–${fmt(a.endsAt, tz, "HH:mm")}`;
    const what = productLine(a, t);
    return {
      id: a.id,
      code: appointmentCode(a.number),
      time,
      what,
      customerName: a.customer.name,
      customerPhone: a.customer.phone,
      address: [l.area, l.building, l.streetAddress, l.apartment && t("dayPlanText.apartment", { value: l.apartment }), l.floor && t("dayPlanText.floor", { value: l.floor })]
        .filter(Boolean)
        .join(t.locale === "ar" ? "، " : ", "),
      mapLink: resolveLocationLink({ mapUrl: l.mapUrl, latitude: l.latitude?.toNumber() ?? null, longitude: l.longitude?.toNumber() ?? null }),
      equipment: a.requiredEquipment,
      notes: a.additionalNotes,
      // What is still to be collected (nothing once a collection is recorded).
      toCollect: due !== null && a.collectedAmount === null ? due : null,
      withOthers: a.technicians.map((x) => x.technician.name).filter((n) => n !== forTechnician),
      status: { name: statusName(a.status, user.locale), color: a.status.color },
      confirmation: t.dyn(`enums.confirmation.${a.customerConfirmation}`),
      confirmed: a.customerConfirmation === "CONFIRMED",
      reminderLink: a.customer.phone
        ? whatsappLink(a.customer.phone, customerReminder(t, a.customer.name, dayLabel, fmt(a.startsAt, tz, "HH:mm"), t.dyn(`enums.visitType.${a.visitType ?? "INSTALLATION"}`), company))
        : null,
    };
  };

  const byTech = new Map<string, { id: string; name: string; phone: string | null; visits: DayPlanVisit[] }>();
  const unassigned: DayPlanVisit[] = [];
  for (const a of rows) {
    if (!a.technicians.length) unassigned.push(visit(a));
    for (const { technician: tech } of a.technicians) {
      const entry = byTech.get(tech.id) ?? { id: tech.id, name: tech.name, phone: tech.phone, visits: [] };
      entry.visits.push(visit(a, tech.name));
      byTech.set(tech.id, entry);
    }
  }
  const technicians = [...byTech.values()]
    .sort((x, y) => x.name.localeCompare(y.name))
    .map((tech) => {
      const message = technicianMessage(t, tech.name, dayLabel, tech.visits);
      return { ...tech, message, link: whatsappLink(tech.phone, message) };
    });
  return { date, dayLabel, visits: rows.length, technicians, unassigned };
}
