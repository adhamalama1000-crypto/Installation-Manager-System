import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { createStocktake, listStocktakes } from "@/server/services/stocktakes";

export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  return listStocktakes(user, { status: p.get("status") ?? undefined, warehouseId: p.get("warehouseId") ?? undefined, page: Number(p.get("page")) || 1 });
});

/** Body: { warehouseId, note }. Takes the snapshot and freezes the warehouse. */
export const POST = apiRoute(async ({ req, user }) => NextResponse.json({ stocktake: await createStocktake(user, await readJson(req)) }, { status: 201 }));
