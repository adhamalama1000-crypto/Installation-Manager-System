import { apiRoute, readJson } from "@/server/http";
import { decideLeave } from "@/server/services/leaves";

export const POST = apiRoute(async ({ req, user, params }) => decideLeave(user, params.id!, await readJson(req)));
