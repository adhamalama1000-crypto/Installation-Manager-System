import { apiRoute, readJson } from "@/server/http";
import { getUserAccess, setUserAccess } from "@/server/services/access-control";

/** A person's permissions, scopes and team as the permission screen shows them (Admin). */
export const GET = apiRoute(async ({ user, params }) => ({ access: await getUserAccess(user, params.id!) }));

/**
 * Body: { mode: "set", permissions, scopes, teamId, reason } | { mode: "reset" } |
 * { mode: "copy", fromUserId } | { mode: "template", template }. Admin only; never one's own.
 */
export const PUT = apiRoute(async ({ req, user, params }) => setUserAccess(user, params.id!, await readJson(req)));
