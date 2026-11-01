import { apiRoute, readJson } from "@/server/http";
import { recordCheckIn } from "@/server/services/field";

/** Body: { kind, appointmentId?, geo?: { lat, lng, acc }, reason?, note? }. */
export const POST = apiRoute(async ({ req, user }) => ({ checkIn: await recordCheckIn(user, await readJson(req)) }));
