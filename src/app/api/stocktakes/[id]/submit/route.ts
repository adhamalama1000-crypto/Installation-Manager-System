import { apiRoute, readJson } from "@/server/http";
import { submitStocktake } from "@/server/services/stocktakes";

export const POST = apiRoute(async ({ req, user, params }) => ({ stocktake: await submitStocktake(user, params.id!, await readJson(req)) }));
