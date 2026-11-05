import { apiRoute, readJson } from "@/server/http";
import { decideViolation } from "@/server/services/penalties";

/** Body: { decision: APPROVED | REJECTED, kind?, amount?, note } (a rejection needs the reason). */
export const POST = apiRoute(async ({ req, user, params }) => ({ violation: await decideViolation(user, params.id!, await readJson(req)) }));
