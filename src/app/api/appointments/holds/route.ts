import { prisma } from "@/server/db";
import { apiRoute, readJson } from "@/server/http";
import { assertCan } from "@/server/access";
import { holdSlot, releaseHolds } from "@/server/services/holds";

/** Hold the chosen technicians' slot for a few minutes while booking (empty list releases). */
export const POST = apiRoute(async ({ req, user }) => ({ hold: await holdSlot(user, await readJson(req)) }));

/** Release the user's holds (booking form closed). */
export const DELETE = apiRoute(async ({ user }) => {
  assertCan(user, "appointments.manage");
  await releaseHolds(prisma, user.id);
  return { ok: true };
});
