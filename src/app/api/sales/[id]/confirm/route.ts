import { apiRoute } from "@/server/http";
import { confirmSale } from "@/server/services/sales";

export const POST = apiRoute(async ({ user, params }) => ({ sale: await confirmSale(user, params.id!) }));
