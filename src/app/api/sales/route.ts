import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { createSale, listSales } from "@/server/services/sales";

/** Query: q, status, from, to, page, pageSize. */
export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  return listSales(user, { q: p.get("q") ?? undefined, status: p.get("status") ?? undefined, from: p.get("from") ?? undefined, to: p.get("to") ?? undefined, page: Number(p.get("page")) || 1, pageSize: Number(p.get("pageSize")) || undefined });
});

/** Body: the sale; `confirm: true` confirms it at once (issues the stock). */
export const POST = apiRoute(async ({ req, user }) => {
  const body = (await readJson(req)) as Record<string, unknown>;
  return NextResponse.json({ sale: await createSale(user, body, { confirm: body?.confirm === true }) }, { status: 201 });
});
