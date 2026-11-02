import { apiRoute, readJson } from "@/server/http";
import { cancelDocument } from "@/server/services/inventory-documents";

/** Body: { reason, version }. A posted document is reversed (reason required); a draft is closed. */
export const POST = apiRoute(async ({ req, user, params }) => ({ document: await cancelDocument(user, params.id!, await readJson(req)) }));
