import { apiRoute, readJson } from "@/server/http";
import { attachVariant } from "@/server/services/product-variants";

/** Body: { productId, variantNameEn, variantNameAr, colorHex? }: an existing product becomes a variant. */
export const POST = apiRoute(async ({ req, user, params }) => ({ product: await attachVariant(user, params.id!, await readJson(req)) }));
