import { apiRoute } from "@/server/http";
import { postDocument } from "@/server/services/inventory-documents";

/** Posts a draft. Posting an already posted document changes nothing (safe to retry). */
export const POST = apiRoute(async ({ user, params }) => ({ document: await postDocument(user, params.id!) }));
