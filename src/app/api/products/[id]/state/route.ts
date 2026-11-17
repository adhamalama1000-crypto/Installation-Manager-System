import { apiRoute, readJson } from "@/server/http";
import { msg } from "@/i18n/translator";
import { ValidationError } from "@/server/errors";
import { archiveProduct, lockProduct, unarchiveProduct, unlockProduct } from "@/server/services/product-lock";

/** Body: { action: "lock" | "unlock" | "archive" | "unarchive", reason? }. Each action has its own permission. */
export const POST = apiRoute(async ({ req, user, params }) => {
  const body = (await readJson(req)) as { action?: unknown } | null;
  const fn = { lock: lockProduct, unlock: unlockProduct, archive: archiveProduct, unarchive: unarchiveProduct }[String(body?.action)];
  if (!fn) throw new ValidationError({ action: msg("validation.invalid") });
  return { product: await fn(user, params.id!, body) };
});
