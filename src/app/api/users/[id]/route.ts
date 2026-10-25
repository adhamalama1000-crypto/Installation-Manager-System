import { apiRoute, readJson } from "@/server/http";
import { getUser, updateUser } from "@/server/services/users";

export const GET = apiRoute(async ({ user, params }) => ({ user: await getUser(user, params.id!) }));

export const PATCH = apiRoute(async ({ req, user, params }) => ({ user: await updateUser(user, params.id!, await readJson(req)) }));
