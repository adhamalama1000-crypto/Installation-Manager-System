import { apiRoute, readJson } from "@/server/http";
import { getComplaint, updateComplaint } from "@/server/services/complaints";

export const GET = apiRoute(async ({ user, params }) => ({ complaint: await getComplaint(user, params.id!) }));

/** Body: { action: "assign" | "linkVisit" | "resolve" | "close" | "reopen", version, ... }. */
export const PATCH = apiRoute(async ({ req, user, params }) => ({ complaint: await updateComplaint(user, params.id!, await readJson(req)) }));
