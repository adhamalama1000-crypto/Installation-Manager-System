import { apiRoute, readJson } from "@/server/http";
import { getSupplier, saveSupplier } from "@/server/services/suppliers";

export const GET = apiRoute(async ({ user, params }) => ({ supplier: await getSupplier(user, params.id!) }));
export const PATCH = apiRoute(async ({ req, user, params }) => ({ supplier: await saveSupplier(user, params.id!, await readJson(req)) }));
