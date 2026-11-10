import { apiRoute } from "@/server/http";
import { importTemplate, xlsxResponse } from "@/server/services/product-import";

export const GET = apiRoute(async ({ user }) => xlsxResponse(await importTemplate(user), "products-import-template.xlsx"));
