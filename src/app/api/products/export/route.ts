import { apiRoute } from "@/server/http";
import { recordExport } from "@/server/services/audit";
import { exportProductsXlsx, xlsxResponse } from "@/server/services/product-import";

export const GET = apiRoute(async ({ user }) => {
  const file = await exportProductsXlsx(user);
  await recordExport(user, "products", "PRODUCT", { bytes: file.byteLength });
  return xlsxResponse(file, `products-${new Date().toISOString().slice(0, 10)}.xlsx`);
});
