import { apiRoute } from "@/server/http";
import { salesAnalytics } from "@/server/services/sales-analytics";

/** Query: from, to (YYYY-MM-DD), categoryId, brandId, warehouseId, productId, rollUp (0 = per variant), slowDays. */
export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  return salesAnalytics(user, {
    from: p.get("from") ?? undefined,
    to: p.get("to") ?? undefined,
    categoryId: p.get("categoryId") || undefined,
    brandId: p.get("brandId") || undefined,
    warehouseId: p.get("warehouseId") || undefined,
    productId: p.get("productId") || undefined,
    rollUp: p.get("rollUp") !== "0",
    slowDays: Number(p.get("slowDays")) || undefined,
  });
});
