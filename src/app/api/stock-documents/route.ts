import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { createDocument, listDocuments } from "@/server/services/inventory-documents";

/** Query: type, status, warehouseId, q (number / reference / supplier or customer), from, to, page. */
export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  return listDocuments(user, {
    type: p.get("type") ?? undefined,
    status: p.get("status") ?? undefined,
    warehouseId: p.get("warehouseId") ?? undefined,
    q: p.get("q") ?? undefined,
    from: p.get("from") ?? undefined,
    to: p.get("to") ?? undefined,
    page: Number(p.get("page")) || 1,
  });
});

/** Body: the document with its lines and a clientRequestId; `post: true` posts it at once. */
export const POST = apiRoute(async ({ req, user }) => {
  const body = (await readJson(req)) as Record<string, unknown>;
  return NextResponse.json({ document: await createDocument(user, body, { post: body.post === true }) }, { status: 201 });
});
