import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { listWorkLocations, saveWorkLocation } from "@/server/services/attendance";

export const GET = apiRoute(async ({ req, user }) => ({ rows: await listWorkLocations(user, new URL(req.url).searchParams.get("all") === "1") }));
export const POST = apiRoute(async ({ req, user }) => NextResponse.json({ id: await saveWorkLocation(user, null, await readJson(req)) }, { status: 201 }));
