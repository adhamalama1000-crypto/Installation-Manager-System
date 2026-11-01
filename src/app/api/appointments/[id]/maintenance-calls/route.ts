import { apiRoute, readJson } from "@/server/http";
import { recordMaintenanceCall } from "@/server/services/after-sales";

export const POST = apiRoute(async ({ req, user, params }) => recordMaintenanceCall(user, params.id!, await readJson(req)));
