import { apiRoute, readJson } from "@/server/http";
import { recordPosition } from "@/server/services/field";

/** Body: { lat, lng, acc }: the technician's position while on the way to a customer. */
export const POST = apiRoute(async ({ req, user }) => recordPosition(user, await readJson(req)));
