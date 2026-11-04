import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { listProducts } from "@/server/services/inventory-catalog";
import { addVariants } from "@/server/services/product-variants";

/** The variants of a product. */
export const GET = apiRoute(async ({ user, params }) => listProducts(user, { level: "all", parentId: params.id!, active: "all", sort: "sku", pageSize: 100 }));

/** Body: { variants: [{ variantNameEn, variantNameAr, colorHex?, sku?, barcode?, generateBarcode?, purchaseCost?, sellingPrice?, minStock? }] } */
export const POST = apiRoute(async ({ req, user, params }) => NextResponse.json(await addVariants(user, params.id!, await readJson(req)), { status: 201 }));
