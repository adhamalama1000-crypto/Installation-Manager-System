import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { listSuppliers, saveSupplier } from "@/server/services/suppliers";

/** Query: q, active (1 | 0 | all), page, pageSize. */
export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  return listSuppliers(user, { q: p.get("q") ?? undefined, active: p.get("active") ?? undefined, page: Number(p.get("page")) || 1, pageSize: Number(p.get("pageSize")) || undefined });
});

export const POST = apiRoute(async ({ req, user }) => NextResponse.json({ supplier: await saveSupplier(user, null, await readJson(req)) }, { status: 201 }));
