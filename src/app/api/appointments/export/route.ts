import { apiRoute } from "@/server/http";
import { assertCan } from "@/server/access";
import { parseAppointmentFilters } from "@/server/services/appointments";
import { appointmentExportRows, appointmentFilterSql } from "@/server/services/appointment-reads";
import { appointmentRowsCsv } from "@/server/services/reports";
import { todayKey } from "@/lib/time";

/** CSV of the appointment list with the current filters (respects scope and field permissions). */
export const GET = apiRoute(async ({ req, user }) => {
  assertCan(user, "appointments.view");
  const filters = parseAppointmentFilters(new URL(req.url).searchParams);
  const rows = await appointmentExportRows(appointmentFilterSql(user, filters), filters.dir);
  const csv = appointmentRowsCsv(user, rows, { detailed: false });
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="appointments-${todayKey(user.settings.timezone)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
