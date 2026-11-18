import { apiRoute } from "@/server/http";
import { openRescheduleRequests } from "@/server/services/reschedule-requests";

/** Open reschedule requests the reader can act on. */
export const GET = apiRoute(async ({ user }) => ({ requests: await openRescheduleRequests(user) }));
