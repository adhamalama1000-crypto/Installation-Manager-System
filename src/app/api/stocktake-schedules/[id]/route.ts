import { apiRoute, readJson } from "@/server/http";
import { updateSchedule } from "@/server/services/stocktake-schedules";

/** Body: the whole schedule with its version (planners). Schedules are ended, never deleted. */
export const PUT = apiRoute(async ({ req, user, params }) => updateSchedule(user, params.id!, await readJson(req)));
