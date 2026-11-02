import { apiRoute } from "@/server/http";
import { listBalances } from "@/server/services/inventory-stock";

/** Query: view (product | location), warehouseId, q, categoryId, low (1), page. */
export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  return listBalances(user, {
    view: p.get("view") ?? undefined,
    warehouseId: p.get("warehouseId") ?? undefined,
    q: p.get("q") ?? undefined,
    categoryId: p.get("categoryId") ?? undefined,
    low: p.get("low") ?? undefined,
    page: Number(p.get("page")) || 1,
  });
});
