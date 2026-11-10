import { apiRoute, readJson } from "@/server/http";
import { scanViolations } from "@/server/services/penalties";

/** Body: { from, to } (company-local days). Proposes what the active rules find; deducts nothing. */
export const POST = apiRoute(async ({ req, user }) => scanViolations(user, await readJson(req)));
