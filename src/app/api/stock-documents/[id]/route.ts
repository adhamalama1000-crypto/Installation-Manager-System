import { apiRoute, readJson } from "@/server/http";
import { getDocument, updateDocument } from "@/server/services/inventory-documents";

export const GET = apiRoute(async ({ user, params }) => ({ document: await getDocument(user, params.id!) }));

/** Edits a draft (whole document, with its version); `post: true` posts it after saving. */
export const PATCH = apiRoute(async ({ req, user, params }) => {
  const body = (await readJson(req)) as Record<string, unknown>;
  return { document: await updateDocument(user, params.id!, body, { post: body.post === true }) };
});
