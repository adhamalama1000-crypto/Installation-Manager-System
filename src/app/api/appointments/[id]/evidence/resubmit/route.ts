import { apiRoute, readJson } from "@/server/http";
import { resubmitWork } from "@/server/services/evidence";

/** Body: { customerConfirmed, customerName, note }. Submits work that was sent back, once corrected. */
export const POST = apiRoute(async ({ req, user, params }) => ({ evidence: await resubmitWork(user, params.id!, await readJson(req)) }));
