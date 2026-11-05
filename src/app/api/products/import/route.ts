import { apiRoute } from "@/server/http";
import { commitImport, previewImport } from "@/server/services/product-import";
import { readLimitedBody } from "@/server/storage";
import { MAX_IMPORT_BYTES } from "@/lib/product-import";

/**
 * Body: the .xlsx file. Query: mode=preview (default; changes nothing) | commit, update=1 (update
 * existing SKUs), createMissing=1 (create unknown brands and categories), skipInvalid=1 (commit the
 * valid rows even when others have errors; otherwise nothing is written while any row has one).
 */
export const POST = apiRoute(async ({ req, user }) => {
  const q = new URL(req.url).searchParams;
  const opts = { update: q.get("update") === "1", createMissing: q.get("createMissing") === "1", skipInvalid: q.get("skipInvalid") === "1" };
  const bytes = await readLimitedBody(req, MAX_IMPORT_BYTES);
  return q.get("mode") === "commit" ? commitImport(user, bytes, opts) : previewImport(user, bytes, opts);
});
