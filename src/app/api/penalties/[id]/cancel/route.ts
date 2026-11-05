import { apiRoute, readJson } from "@/server/http";
import { cancelViolation } from "@/server/services/penalties";

/** Body: { reason }. An approved deduction is reversed in finance; the record stays. */
export const POST = apiRoute(async ({ req, user, params }) => ({ violation: await cancelViolation(user, params.id!, await readJson(req)) }));
