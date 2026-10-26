import "server-only";
import type { CustomerConfirmation } from "@prisma/client";
import type { Locale } from "@/i18n/config";
import { createFormatter } from "@/i18n/format";
import { enumLabel, translate } from "@/i18n/translate";
import { appointmentCode } from "@/lib/constants";
import { customerReminder, technicianMessage, whatsappLink, type PlanVisit } from "@/lib/day-plan";
import { productLine } from "@/lib/format";
import { resolveLocationLink } from "@/lib/maps";
import { dayRangeUtc } from "@/lib/time";
import { prisma } from "../db";
import { appointmentScope, assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { amountDue } from "./payments";

export type DayPlanVisit = PlanVisit & {
  id: string;
  status: { name: string; nameAr: string | null; color: string };
  confirmation: CustomerConfirmation;
  confirmed: boolean;
  reminderLink: string | null;
};

/**
 * Aura's day plan: per technician, the visits of one day as a ready-to-send WhatsApp message, plus
 * a reminder link for each customer. Cancelled and postponed visits are left out. `lang` is the
 * language of the messages (Arabic or English), independent of the reader's interface.
 */
export async function dayPlan(user: CurrentUser, date: string, lang: Locale = "en") {
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

  const f = createFormatter(lang, tz);
  const label = (type: Parameters<typeof enumLabel>[1], value: string) => enumLabel(lang, type, value);
  const dayLabel = f.day(date, { weekday: "long", day: "numeric", month: "long" });
  const company = user.settings.companyName || translate(lang, "wa.cust.companyFallback");

  const visit = (a: (typeof rows)[number], forTechnician?: string): DayPlanVisit => {
    const l = a.location;
    const due = amountDue(a);
    const time = f.timeRange(a.startsAt, a.endsAt);
    const what = productLine(a, label);
    return {
      id: a.id,
      code: appointmentCode(a.number),
      time,
      what,
      customerName: a.customer.name,
      customerPhone: a.customer.phone,
      address: f.join([
        l.area,
        l.building,
        l.streetAddress,
        l.apartment && translate(lang, "wa.address.apt", { value: l.apartment }),
        l.floor && translate(lang, "wa.address.floor", { value: l.floor }),
      ]),
      mapLink: resolveLocationLink({ mapUrl: l.mapUrl, latitude: l.latitude?.toNumber() ?? null, longitude: l.longitude?.toNumber() ?? null }),
      equipment: a.requiredEquipment,
      notes: a.additionalNotes,
      // What is still to be collected (nothing once a collection is recorded).
      toCollect: due !== null && a.collectedAmount === null ? due : null,
      withOthers: a.technicians.map((t) => t.technician.name).filter((n) => n !== forTechnician),
      status: a.status,
      confirmation: a.customerConfirmation,
      confirmed: a.customerConfirmation === "CONFIRMED",
      reminderLink: a.customer.phone
        ? whatsappLink(
            a.customer.phone,
            customerReminder(
              a.customer.name,
              dayLabel,
              f.time(a.startsAt),
              a.visitType ? label("visitType", a.visitType) : translate(lang, "wa.cust.visitFallback"),
              company,
              lang,
              a.productCategory === "SMART_LOCK" ? "lock" : a.productCategory === "SMART_HOME" ? "smart" : undefined,
            ),
          )
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
      const message = technicianMessage(t.name, dayLabel, t.visits, lang);
      return { ...t, message, link: whatsappLink(t.phone, message) };
    });
  return { date, lang, dayLabel, visits: rows.length, technicians, unassigned };
}
