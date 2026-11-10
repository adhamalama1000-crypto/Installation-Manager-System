import { apiRoute, readJson } from "@/server/http";
import { cancelSale } from "@/server/services/sales";

/** Body: { reason, version }. A confirmed sale needs sales.void and a reason (its stock issue is reversed). */
export const POST = apiRoute(async ({ req, user, params }) => ({ sale: await cancelSale(user, params.id!, await readJson(req)) }));
