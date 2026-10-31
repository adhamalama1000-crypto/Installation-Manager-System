import { apiRoute, readJson } from "@/server/http";
import { setDeliveryChecklist } from "@/server/services/attachments";

export const PUT = apiRoute(async ({ req, user, params }) => ({ items: await setDeliveryChecklist(user, params.id!, await readJson(req)) }));
