import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { listWarehouses, saveWarehouse } from "@/server/services/inventory-warehouses";

export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  return listWarehouses(user, { q: p.get("q") ?? undefined, kind: p.get("kind") ?? undefined, active: p.get("active") ?? undefined, page: Number(p.get("page")) || 1 });
});

export const POST = apiRoute(async ({ req, user }) => NextResponse.json({ warehouse: await saveWarehouse(user, null, await readJson(req)) }, { status: 201 }));
