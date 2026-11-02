import { apiRoute, readJson } from "@/server/http";
import { getWarehouse, saveWarehouse } from "@/server/services/inventory-warehouses";

export const GET = apiRoute(async ({ user, params }) => ({ warehouse: await getWarehouse(user, params.id!) }));

export const PATCH = apiRoute(async ({ req, user, params }) => ({ warehouse: await saveWarehouse(user, params.id!, await readJson(req)) }));
