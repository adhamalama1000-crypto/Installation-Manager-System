import { assertCanAny } from "@/server/access";
import { apiRoute } from "@/server/http";
import { listWorkHours } from "@/server/services/work-hours";

/** Every active technician's working hours (scheduling managers and company schedule readers). */
export const GET = apiRoute(async ({ user }) => {
  assertCanAny(user, "schedule.manage", "schedule.global");
  return { technicians: await listWorkHours() };
});
