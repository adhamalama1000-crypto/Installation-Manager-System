import { apiRoute, readJson } from "@/server/http";
import { savePenaltyRule } from "@/server/services/penalties";

export const PATCH = apiRoute(async ({ req, user, params }) => ({ rule: await savePenaltyRule(user, params.id!, await readJson(req)) }));
