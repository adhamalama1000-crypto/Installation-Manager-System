import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { createLeave, leaveOverview } from "@/server/services/leaves";

export const GET = apiRoute(async ({ user }) => leaveOverview(user));

export const POST = apiRoute(async ({ req, user }) => NextResponse.json(await createLeave(user, await readJson(req)), { status: 201 }));
