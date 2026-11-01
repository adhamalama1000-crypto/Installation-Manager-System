import { apiRoute, readJson } from "@/server/http";
import { approveStocktake } from "@/server/services/stocktakes";

export const POST = apiRoute(async ({ req, user, params }) => ({ stocktake: await approveStocktake(user, params.id!, await readJson(req)) }));
