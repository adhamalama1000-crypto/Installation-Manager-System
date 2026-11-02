import { apiRoute, readJson } from "@/server/http";
import { addStocktakeLine } from "@/server/services/stocktakes";

export const POST = apiRoute(async ({ req, user, params }) => ({ stocktake: await addStocktakeLine(user, params.id!, await readJson(req)) }));
