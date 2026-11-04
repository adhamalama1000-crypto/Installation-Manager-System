import { apiRoute } from "@/server/http";
import { makeImageFirst } from "@/server/services/product-images";

export const POST = apiRoute(async ({ user, params }) => ({ images: await makeImageFirst(user, params.id!) }));
