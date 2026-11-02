import { apiRoute, readJson } from "@/server/http";
import { getProduct, saveProduct } from "@/server/services/inventory-catalog";

export const GET = apiRoute(async ({ user, params }) => ({ product: await getProduct(user, params.id!) }));

/** Body: the whole product, with the version it was read at. */
export const PATCH = apiRoute(async ({ req, user, params }) => ({ product: await saveProduct(user, params.id!, await readJson(req)) }));
