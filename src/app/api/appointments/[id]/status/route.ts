import { apiRoute, readJson } from "@/server/http";
import { changeAppointmentStatus } from "@/server/services/appointments";

export const POST = apiRoute(async ({ req, user, params }) => ({
  appointment: await changeAppointmentStatus(user, params.id!, await readJson(req)),
}));
