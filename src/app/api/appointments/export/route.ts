import { hasPermission } from "@/server/access";
import { apiRoute } from "@/server/http";
import { assertCan } from "@/server/access";
import { parseAppointmentFilters } from "@/server/services/appointments";
import { appointmentExportRows, appointmentFilterSql } from "@/server/services/appointment-reads";
import { appointmentRowsCsv } from "@/server/services/reports";
import { localeFromRequest } from "@/i18n/server";
import { todayKey } from "@/lib/time";

/** CSV of the appointment list with the current filters (respects scope and field permissions). */
export const GET = apiRoute(async ({ req, user }) => {
  assertCan(user, "appointments.view");
  const filters = parseAppointmentFilters(new URL(req.url).searchParams);
  const tz = user.settings.timezone;
  const rows = await appointmentExportRows(appointmentFilterSql(user, filters), filters.dir);
  const csv = appointmentRowsCsv(
    rows,
    { contact: hasPermission(user, "customers.contact"), location: hasPermission(user, "location.view") },
    localeFromRequest(req, user.locale),
    tz,
  );
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="appointments-${todayKey(tz)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
