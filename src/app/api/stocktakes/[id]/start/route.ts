import { apiRoute } from "@/server/http";
import { startStocktake } from "@/server/services/stocktakes";

/** Starts a planned session: snapshot and freeze (assignees, or anyone who counts when it has none). */
export const POST = apiRoute(async ({ user, params }) => ({ stocktake: await startStocktake(user, params.id!) }));
