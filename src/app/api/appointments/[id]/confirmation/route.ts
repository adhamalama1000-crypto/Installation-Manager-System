import { apiRoute, readJson } from "@/server/http";
import { setCustomerConfirmation } from "@/server/services/appointments";

export const POST = apiRoute(async ({ req, user, params }) => ({
  appointment: await setCustomerConfirmation(user, params.id!, await readJson(req)),
}));
