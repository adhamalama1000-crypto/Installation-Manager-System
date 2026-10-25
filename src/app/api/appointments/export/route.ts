import { hasPermission } from "@/server/access";
import { apiRoute } from "@/server/http";
import { assertCan } from "@/server/access";
import { categoryLabel, parseAppointmentFilters } from "@/server/services/appointments";
import { appointmentExportRows, appointmentFilterSql } from "@/server/services/appointment-reads";
import { toCsv } from "@/server/services/reports";
import { appointmentCode } from "@/lib/constants";
import { fmt, todayKey } from "@/lib/time";

/** CSV of the appointment list with the current filters (respects scope and field permissions). */
export const GET = apiRoute(async ({ req, user }) => {
  assertCan(user, "appointments.view");
  const filters = parseAppointmentFilters(new URL(req.url).searchParams);
  const tz = user.settings.timezone;
  const rows = await appointmentExportRows(appointmentFilterSql(user, filters), filters.dir);
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
      a.statusName,
      a.customerName,
      ...(contact ? [a.phone] : []),
      ...(loc ? [a.area, a.streetAddress, a.building, a.apartment, a.floor, a.mapUrl] : []),
      categoryLabel(a),
      a.brand,
      a.model,
      a.creatorName,
      a.technicianNames ?? "",
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
