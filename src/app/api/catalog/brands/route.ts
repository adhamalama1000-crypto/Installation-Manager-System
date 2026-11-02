import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { listBrands, saveBrand } from "@/server/services/inventory-catalog";

export const GET = apiRoute(async ({ user }) => ({ brands: await listBrands(user) }));

export const POST = apiRoute(async ({ req, user }) => NextResponse.json({ item: await saveBrand(user, null, await readJson(req)) }, { status: 201 }));
