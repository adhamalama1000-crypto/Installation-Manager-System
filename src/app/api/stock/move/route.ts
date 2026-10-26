import { apiRoute, readJson } from "@/server/http";
import { moveStock } from "@/server/services/stock";

export const POST = apiRoute(async ({ req, user }) => moveStock(user, await readJson(req)));
