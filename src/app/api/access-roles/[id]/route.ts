import { apiRoute, readJson } from "@/server/http";
import { getAccessRole, updateAccessRole } from "@/server/services/access-roles";

/** One custom role with its members and what may be given (Admin). */
export const GET = apiRoute(async ({ user, params }) => ({ role: await getAccessRole(user, params.id!) }));

/** Body: { name, nameAr?, description?, permissions?, scopes?, isActive?, version, reason? } (Admin). Never deleted. */
export const PUT = apiRoute(async ({ req, user, params }) => updateAccessRole(user, params.id!, await readJson(req)));
