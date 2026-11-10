import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { clock, clockState } from "@/server/services/attendance";

/** Today's clock-in / out, visits and work locations for the clock page. */
export const GET = apiRoute(async ({ user }) => clockState(user));

/**
 * Body: { action: IN | OUT, site: COMPANY | CUSTOMER | WORK_LOCATION, appointmentId?, workLocationId?,
 * geo?: { lat, lng, acc } from the browser's Geolocation API, selfie: data URL of the camera photo, note? }.
 * The time is the server's.
 */
export const POST = apiRoute(async ({ req, user }) => NextResponse.json({ checkIn: await clock(user, await readJson(req)) }, { status: 201 }));
