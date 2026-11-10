import { apiRoute, readJson } from "@/server/http";
import { reviewCheckIn } from "@/server/services/attendance";

/** Body: { decision: ACCEPTED | REJECTED, note } for the check-in [id] (a rejection needs a note). */
export const POST = apiRoute(async ({ req, user, params }) => ({ review: await reviewCheckIn(user, params.id!, await readJson(req)) }));
