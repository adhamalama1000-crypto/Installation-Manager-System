import { apiRoute, readJson } from "@/server/http";
import { saveBin } from "@/server/services/inventory-warehouses";

export const PATCH = apiRoute(async ({ req, user, params }) => ({ bin: await saveBin(user, params.id!, params.binId!, await readJson(req)) }));
