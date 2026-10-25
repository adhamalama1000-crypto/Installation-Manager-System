import { apiRoute } from "@/server/http";
import { calendarAppointments, parseAppointmentFilters } from "@/server/services/appointments";

export const GET = apiRoute(async ({ req, user }) => {
  const params = new URL(req.url).searchParams;
  const range = { from: params.get("from") ?? "", to: params.get("to") ?? "" };
  params.delete("from");
  params.delete("to");
  const filters = parseAppointmentFilters(params);
  return { events: await calendarAppointments(user, range, filters) };
});
