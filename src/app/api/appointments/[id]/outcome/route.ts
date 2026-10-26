import { apiRoute, readJson } from "@/server/http";
import { recordVisitOutcome } from "@/server/services/appointments";

export const POST = apiRoute(async ({ req, user, params }) => ({
  appointment: await recordVisitOutcome(user, params.id!, await readJson(req)),
}));
