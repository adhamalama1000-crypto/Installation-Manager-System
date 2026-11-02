import { apiRoute, readJson } from "@/server/http";
import { cancelStocktake } from "@/server/services/stocktakes";

export const POST = apiRoute(async ({ req, user, params }) => ({ stocktake: await cancelStocktake(user, params.id!, await readJson(req)) }));
