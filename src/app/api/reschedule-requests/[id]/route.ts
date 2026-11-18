import { apiRoute, readJson } from "@/server/http";
import { resolveReschedule } from "@/server/services/reschedule-requests";

/** Body: { status: "DONE" | "DECLINED", note? } (a note is required to decline). */
export const POST = apiRoute(async ({ req, user, params }) => ({ request: await resolveReschedule(user, params.id!, await readJson(req)) }));
