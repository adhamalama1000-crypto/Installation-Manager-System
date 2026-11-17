import { apiRoute, readJson } from "@/server/http";
import { returnForRecount } from "@/server/services/stocktakes";

/** Body: { note, lineIds? } (approvers who did not count). */
export const POST = apiRoute(async ({ req, user, params }) => ({ stocktake: await returnForRecount(user, params.id!, await readJson(req)) }));
