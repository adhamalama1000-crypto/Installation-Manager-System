import { apiRoute, readJson } from "@/server/http";
import { saveCounts } from "@/server/services/stocktakes";

export const POST = apiRoute(async ({ req, user, params }) => ({ stocktake: await saveCounts(user, params.id!, await readJson(req)) }));
