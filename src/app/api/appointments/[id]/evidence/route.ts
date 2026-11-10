import { apiRoute } from "@/server/http";
import { evidenceStatus } from "@/server/services/evidence";

/** What the visit must show, what it has, what is missing, and its review history. */
export const GET = apiRoute(async ({ user, params }) => ({ evidence: await evidenceStatus(user, params.id!) }));
