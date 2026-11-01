import { apiRoute, readJson } from "@/server/http";
import { reorderRoute } from "@/server/services/car";

/** Body: { day, ids }: the car's stops in the chosen order. */
export const PUT = apiRoute(async ({ req, user }) => ({ route: await reorderRoute(user, await readJson(req)) }));
