import { apiRoute, readJson } from "@/server/http";
import { getSale, updateSale } from "@/server/services/sales";

export const GET = apiRoute(async ({ user, params }) => ({ sale: await getSale(user, params.id!) }));

/** Body: the whole draft with the version it was read at; `confirm: true` confirms it too. */
export const PATCH = apiRoute(async ({ req, user, params }) => {
  const body = (await readJson(req)) as Record<string, unknown>;
  return { sale: await updateSale(user, params.id!, body, { confirm: body?.confirm === true }) };
});
