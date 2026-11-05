import { apiRoute } from "@/server/http";
import { exportProductsXlsx, xlsxResponse } from "@/server/services/product-import";

export const GET = apiRoute(async ({ user }) => xlsxResponse(await exportProductsXlsx(user), `products-${new Date().toISOString().slice(0, 10)}.xlsx`));
