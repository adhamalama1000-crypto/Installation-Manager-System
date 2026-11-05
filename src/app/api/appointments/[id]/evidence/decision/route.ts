import { apiRoute, readJson } from "@/server/http";
import { decideWork } from "@/server/services/evidence";

/** Body: { decision: APPROVED | REJECTED, note } (a rejection needs the reason). */
export const POST = apiRoute(async ({ req, user, params }) => ({ evidence: await decideWork(user, params.id!, await readJson(req)) }));
