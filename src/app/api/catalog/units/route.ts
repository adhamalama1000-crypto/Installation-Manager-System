import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { listUnits, saveUnit } from "@/server/services/inventory-catalog";

export const GET = apiRoute(async ({ user }) => ({ units: await listUnits(user) }));

export const POST = apiRoute(async ({ req, user }) => NextResponse.json({ item: await saveUnit(user, null, await readJson(req)) }, { status: 201 }));
