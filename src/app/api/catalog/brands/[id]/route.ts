import { apiRoute, readJson } from "@/server/http";
import { saveBrand } from "@/server/services/inventory-catalog";

export const PATCH = apiRoute(async ({ req, user, params }) => ({ item: await saveBrand(user, params.id!, await readJson(req)) }));
