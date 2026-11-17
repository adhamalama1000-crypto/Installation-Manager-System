import { apiRoute, readJson } from "@/server/http";
import { setWorkHours } from "@/server/services/work-hours";

/** Body: { days: [{ weekday, isOff, startTime, endTime }] x 7, reason? } (schedule.manage). */
export const PUT = apiRoute(async ({ req, user, params }) => setWorkHours(user, params.technicianId!, await readJson(req)));
