import { apiRoute } from "@/server/http";
import { getAppointmentHistory } from "@/server/services/appointments";

export const GET = apiRoute(async ({ user, params }) => ({ history: await getAppointmentHistory(user, params.id!) }));
