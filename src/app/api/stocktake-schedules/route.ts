import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { createSchedule, listSchedules } from "@/server/services/stocktake-schedules";

export const GET = apiRoute(async ({ user }) => ({ schedules: await listSchedules(user) }));

/** Body: see stocktakeScheduleSchema (planners). Creates the planned sessions too. */
export const POST = apiRoute(async ({ req, user }) => NextResponse.json(await createSchedule(user, await readJson(req)), { status: 201 }));
