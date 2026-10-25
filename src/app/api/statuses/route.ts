import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { createStatus, listStatuses } from "@/server/services/statuses";

export const GET = apiRoute(async () => ({ statuses: await listStatuses() }));

export const POST = apiRoute(async ({ req, user }) => NextResponse.json({ status: await createStatus(user, await readJson(req)) }, { status: 201 }));
