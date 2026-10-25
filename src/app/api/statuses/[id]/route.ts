import { apiRoute, readJson } from "@/server/http";
import { updateStatus } from "@/server/services/statuses";

export const PATCH = apiRoute(async ({ req, user, params }) => ({ status: await updateStatus(user, params.id!, await readJson(req)) }));
