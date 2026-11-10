import { apiRoute, readJson } from "@/server/http";
import { saveWorkLocation } from "@/server/services/attendance";

export const PATCH = apiRoute(async ({ req, user, params }) => ({ id: await saveWorkLocation(user, params.id!, await readJson(req)) }));
