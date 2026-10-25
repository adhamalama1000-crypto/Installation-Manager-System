import { apiRoute, readJson } from "@/server/http";
import { getAppointment, updateAppointment } from "@/server/services/appointments";

export const GET = apiRoute(async ({ user, params }) => ({ appointment: await getAppointment(user, params.id!) }));

export const PATCH = apiRoute(async ({ req, user, params }) => ({
  appointment: await updateAppointment(user, params.id!, await readJson(req)),
}));
