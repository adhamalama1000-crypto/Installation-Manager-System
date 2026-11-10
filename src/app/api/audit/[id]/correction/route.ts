import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { recordCorrection } from "@/server/services/audit-log";

/** Body: { reason, note }. Adds a correction entry for the audit entry [id]; history is never changed (Admin). */
export const POST = apiRoute(async ({ req, user, params }) => NextResponse.json(await recordCorrection(user, params.id!, await readJson(req)), { status: 201 }));
