import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { listCategories, saveCategory } from "@/server/services/inventory-catalog";

export const GET = apiRoute(async ({ user }) => ({ categories: await listCategories(user) }));

export const POST = apiRoute(async ({ req, user }) => NextResponse.json({ item: await saveCategory(user, null, await readJson(req)) }, { status: 201 }));
