import { apiRoute } from "@/server/http";
import { supplierOptions } from "@/server/services/suppliers";

/** Active suppliers for pickers on stock documents: ?q= */
export const GET = apiRoute(async ({ req, user }) => ({ rows: await supplierOptions(user, new URL(req.url).searchParams.get("q") ?? "") }));
