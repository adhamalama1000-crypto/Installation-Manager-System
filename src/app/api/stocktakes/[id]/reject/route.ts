import { apiRoute, readJson } from "@/server/http";
import { rejectStocktake } from "@/server/services/stocktakes";

export const POST = apiRoute(async ({ req, user, params }) => ({ stocktake: await rejectStocktake(user, params.id!, await readJson(req)) }));
