import { apiRoute } from "@/server/http";
import { availability } from "@/server/services/inventory-stock";

/** Query: productId, warehouseId. Quantity per bin and the serial numbers there. */
export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  return availability(user, p.get("productId") ?? "", p.get("warehouseId") ?? "");
});
