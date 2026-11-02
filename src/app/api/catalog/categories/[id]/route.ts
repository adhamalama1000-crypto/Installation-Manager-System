import { apiRoute, readJson } from "@/server/http";
import { saveCategory } from "@/server/services/inventory-catalog";

export const PATCH = apiRoute(async ({ req, user, params }) => ({ item: await saveCategory(user, params.id!, await readJson(req)) }));
