import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { saveBin } from "@/server/services/inventory-warehouses";

export const POST = apiRoute(async ({ req, user, params }) => NextResponse.json({ bin: await saveBin(user, params.id!, null, await readJson(req)) }, { status: 201 }));
