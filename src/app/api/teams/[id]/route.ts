import { apiRoute, readJson } from "@/server/http";
import { saveTeam } from "@/server/services/access-control";

export const PATCH = apiRoute(async ({ req, user, params }) => saveTeam(user, params.id!, await readJson(req)));
