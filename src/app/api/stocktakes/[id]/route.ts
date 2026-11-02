import { apiRoute } from "@/server/http";
import { getStocktake } from "@/server/services/stocktakes";

export const GET = apiRoute(async ({ user, params }) => ({ stocktake: await getStocktake(user, params.id!) }));
