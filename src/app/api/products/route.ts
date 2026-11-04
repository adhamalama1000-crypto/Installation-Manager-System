import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { listProducts, saveProduct } from "@/server/services/inventory-catalog";

/**
 * Query: q, categoryId, brandId, unitId, active (1 | 0 | all), sort, dir, page, pageSize,
 * warehouseId (availability there), level (stock = what holds stock, the default; top = the
 * catalogue list; all), parentId (the variants of a product).
 */
export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  return listProducts(user, {
    q: p.get("q") ?? undefined,
    categoryId: p.get("categoryId") ?? undefined,
    brandId: p.get("brandId") ?? undefined,
    unitId: p.get("unitId") ?? undefined,
    active: p.get("active") ?? undefined,
    sort: p.get("sort") ?? undefined,
    dir: p.get("dir") ?? undefined,
    page: Number(p.get("page")) || 1,
    pageSize: Number(p.get("pageSize")) || undefined,
    warehouseId: p.get("warehouseId") ?? undefined,
    level: p.get("level") ?? undefined,
    parentId: p.get("parentId") ?? undefined,
  });
});

export const POST = apiRoute(async ({ req, user }) => NextResponse.json({ product: await saveProduct(user, null, await readJson(req)) }, { status: 201 }));
