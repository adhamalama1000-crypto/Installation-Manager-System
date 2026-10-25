import { prisma } from "@/server/db";
import { hasPermission } from "@/server/access";
import { apiRoute } from "@/server/http";
import { assertCan } from "@/server/access";
import { buildAppointmentWhere, categoryLabel, parseAppointmentFilters } from "@/server/services/appointments";
import { toCsv } from "@/server/services/reports";
import { appointmentCode } from "@/lib/constants";
import { fmt, todayKey } from "@/lib/time";

/** CSV of the appointment list with the current filters (respects scope and field permissions). */
export const GET = apiRoute(async ({ req, user }) => {
  assertCan(user, "appointments.view");
  const filters = parseAppointmentFilters(new URL(req.url).searchParams);
  const tz = user.settings.timezone;
  const rows = await prisma.appointment.findMany({
    where: buildAppointmentWhere(user, filters),
    include: {
      customer: true,
      location: true,
      status: true,
      createdBy: { select: { name: true } },
      technicians: { include: { technician: { select: { name: true } } } },
    },
    orderBy: { startsAt: filters.dir },
    take: 20_000,
  });
  const contact = hasPermission(user, "customers.contact");
  const loc = hasPermission(user, "location.view");
  const csv = toCsv([
    [
      "Appointment ID",
      "Date",
      "Start",
      "End",
      "Status",
      "Customer",
      ...(contact ? ["Phone"] : []),
      ...(loc ? ["Area", "Address", "Compound/Building", "Apartment", "Floor", "Map link"] : []),
      "Category",
      "Brand",
      "Model",
      "Sales employee",
      "Technicians",
    ],
    ...rows.map((a) => [
      appointmentCode(a.number),
      fmt(a.startsAt, tz, "yyyy-MM-dd"),
      fmt(a.startsAt, tz, "HH:mm"),
      fmt(a.endsAt, tz, "HH:mm"),
      a.status.name,
      a.customer.name,
      ...(contact ? [a.customer.phone] : []),
      ...(loc ? [a.location.area, a.location.streetAddress, a.location.building, a.location.apartment, a.location.floor, a.location.mapUrl] : []),
      categoryLabel(a),
      a.brand,
      a.model,
      a.createdBy.name,
      a.technicians.map((t) => t.technician.name).join("; "),
    ]),
  ]);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="appointments-${todayKey(tz)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
