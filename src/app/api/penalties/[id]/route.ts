import { apiRoute } from "@/server/http";
import { getViolation } from "@/server/services/penalties";

export const GET = apiRoute(async ({ user, params }) => ({ violation: await getViolation(user, params.id!) }));
