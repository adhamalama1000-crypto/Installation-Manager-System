import { apiRoute } from "@/server/http";
import { listMovements } from "@/server/services/inventory-stock";

/** Query: productId, warehouseId, type, q (document number, SKU or serial), from, to, page. */
export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  return listMovements(user, {
    productId: p.get("productId") ?? undefined,
    warehouseId: p.get("warehouseId") ?? undefined,
    type: p.get("type") ?? undefined,
    q: p.get("q") ?? undefined,
    from: p.get("from") ?? undefined,
    to: p.get("to") ?? undefined,
    page: Number(p.get("page")) || 1,
  });
});
