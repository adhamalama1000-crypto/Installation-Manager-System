import { apiRoute, readJson } from "@/server/http";
import { updatePlannedStocktake } from "@/server/services/stocktakes";

/** Body: { date, startTime, durationMinutes, assigneeIds, supervisorId, instructions?, reason?, version } (planners). */
export const PUT = apiRoute(async ({ req, user, params }) => ({ stocktake: await updatePlannedStocktake(user, params.id!, await readJson(req)) }));
