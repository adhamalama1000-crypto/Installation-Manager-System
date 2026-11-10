import { availabilitySchema, fieldErrorsFromZod } from "@/lib/validation";
import { computeEnd, zonedToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { assertCanAny } from "@/server/access";
import { ValidationError } from "@/server/errors";
import { apiRoute, readJson } from "@/server/http";
import { technicianAvailability } from "@/server/services/scheduling";
import { suggestTechnicians } from "@/server/services/booking-helpers";
import { areaGeo } from "@/lib/areas";

/** Live availability of all active technicians for a proposed slot (booking form). */
export const POST = apiRoute(async ({ req, user }) => {
  assertCanAny(user, "appointments.create", "appointments.manage");
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
    timezone: settings.timezone,
  });
  // Aura's suggestion: specialty, holds by others, how full their day is and how close their next visit is.
  const lat = Number(parsed.data.latitude);
  const lng = Number(parsed.data.longitude);
  const suggestions = await suggestTechnicians(user, {
    startsAt,
    endsAt,
    category: parsed.data.productCategory ?? null,
    here: parsed.data.latitude && parsed.data.longitude && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : areaGeo(parsed.data.area),
    excludeAppointmentId: parsed.data.excludeAppointmentId,
    available: Object.fromEntries(technicians.map((t) => [t.id, t.available])),
  });
  return {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    technicians: technicians.map((t) => ({ ...t, ...suggestions[t.id], available: t.available && !suggestions[t.id]?.heldBy })),
  };
});
