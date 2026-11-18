import { apiRoute } from "@/server/http";
import { stocktakeDashboard } from "@/server/services/stocktake-dashboard";

/** ?warehouseId=&userId=&productId=&categoryId=&from=&to=&status=&month= */
export const GET = apiRoute(async ({ req, user }) => {
  const q = new URL(req.url).searchParams;
  const get = (k: string) => q.get(k)?.slice(0, 64) || undefined;
  return stocktakeDashboard(user, { warehouseId: get("warehouseId"), userId: get("userId"), productId: get("productId"), categoryId: get("categoryId"), from: get("from"), to: get("to"), status: get("status"), month: get("month") });
});
