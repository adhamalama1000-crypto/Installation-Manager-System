import { apiRoute } from "@/server/http";
import { cancelLeave } from "@/server/services/leaves";

export const POST = apiRoute(async ({ user, params }) => ({ leave: await cancelLeave(user, params.id!) }));
