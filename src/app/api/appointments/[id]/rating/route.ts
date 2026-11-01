import { apiRoute, readJson } from "@/server/http";
import { setCustomerRating } from "@/server/services/after-sales";

export const PUT = apiRoute(async ({ req, user, params }) => setCustomerRating(user, params.id!, await readJson(req)));
