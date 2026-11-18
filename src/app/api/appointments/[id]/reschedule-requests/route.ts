import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { requestReschedule } from "@/server/services/reschedule-requests";

/** An assigned technician asks to move the visit. Body: { reason, proposedDate?, proposedTime? }. */
export const POST = apiRoute(async ({ req, user, params }) => NextResponse.json({ request: await requestReschedule(user, params.id!, await readJson(req)) }, { status: 201 }));
