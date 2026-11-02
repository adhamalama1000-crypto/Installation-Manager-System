import { apiRoute, readJson } from "@/server/http";
import { saveUnit } from "@/server/services/inventory-catalog";

export const PATCH = apiRoute(async ({ req, user, params }) => ({ item: await saveUnit(user, params.id!, await readJson(req)) }));
