import { apiRoute } from "@/server/http";
import { detachVariant } from "@/server/services/product-variants";

/** The variant [id] becomes a separate product again. */
export const POST = apiRoute(async ({ user, params }) => ({ product: await detachVariant(user, params.id!) }));
