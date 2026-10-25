import { availabilitySchema, fieldErrorsFromZod } from "@/lib/validation";
import { computeEnd, zonedToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { assertCan } from "@/server/access";
import { ValidationError } from "@/server/errors";
import { apiRoute, readJson } from "@/server/http";
import { technicianAvailability } from "@/server/services/scheduling";

/** Live availability of all active technicians for a proposed slot (booking form). */
export const POST = apiRoute(async ({ req, user }) => {
  assertCan(user, "appointments.manage");
  const parsed = availabilitySchema.safeParse(await readJson(req));
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const settings = user.settings; // loaded with the session for this request
  const startsAt = zonedToUtc(parsed.data.date, parsed.data.startTime, settings.timezone);
  const endsAt = computeEnd(startsAt, parsed.data.durationMinutes);
  const technicians = await technicianAvailability(prisma, {
    startsAt,
    endsAt,
    excludeAppointmentId: parsed.data.excludeAppointmentId,
    bufferMinutes: settings.travelBufferMinutes,
  });
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), technicians };
});
