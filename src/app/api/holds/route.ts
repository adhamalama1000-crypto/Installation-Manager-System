import { apiRoute, readJson } from "@/server/http";
import { holdSlot, releaseHolds } from "@/server/services/booking-helpers";

/** Body: { date, startTime, durationMinutes, technicianIds, excludeAppointmentId? }: holds them for 10 minutes. */
export const POST = apiRoute(async ({ req, user }) => holdSlot(user, await readJson(req)));

/** Lets go of the reader's holds. */
export const DELETE = apiRoute(async ({ user }) => releaseHolds(user));
