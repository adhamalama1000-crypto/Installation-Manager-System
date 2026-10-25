import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { stockIn, stockOverview } from "@/server/services/stock";

export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  return stockOverview(user, {
    q: p.get("q") ?? undefined,
    status: p.get("status") ?? undefined,
    modelId: p.get("modelId") ?? undefined,
    holderId: p.get("holderId") ?? undefined,
    page: Number(p.get("page")) || 1,
  });
});

/** Goods in. */
export const POST = apiRoute(async ({ req, user }) => NextResponse.json(await stockIn(user, await readJson(req)), { status: 201 }));
