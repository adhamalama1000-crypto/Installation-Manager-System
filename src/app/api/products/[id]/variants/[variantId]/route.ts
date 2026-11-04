import { apiRoute, readJson } from "@/server/http";
import { saveVariant } from "@/server/services/product-variants";

/** Body: the variant's own fields, with the version it was read at. */
export const PATCH = apiRoute(async ({ req, user, params }) => ({ product: await saveVariant(user, params.id!, params.variantId!, await readJson(req)) }));
