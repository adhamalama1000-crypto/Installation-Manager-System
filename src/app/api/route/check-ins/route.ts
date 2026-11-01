import { apiRoute, readJson } from "@/server/http";
import { carCheckIn } from "@/server/services/car";

/** Body: { kind: CAR_GO | CAR_DROP | CAR_PICK | CAR_BACK, appointmentId?, geo? }. */
export const POST = apiRoute(async ({ req, user }) => ({ checkIn: await carCheckIn(user, await readJson(req)) }));
