import { apiRoute, readJson } from "@/server/http";
import { cancelAppointment } from "@/server/services/appointments";

export const POST = apiRoute(async ({ req, user, params }) => ({
  appointment: await cancelAppointment(user, params.id!, await readJson(req)),
}));
