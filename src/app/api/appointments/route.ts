import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { createAppointment, listAppointments, parseAppointmentFilters } from "@/server/services/appointments";

export const GET = apiRoute(async ({ req, user }) => {
  const filters = parseAppointmentFilters(new URL(req.url).searchParams);
  return listAppointments(user, filters);
});

export const POST = apiRoute(async ({ req, user }) => {
  const appointment = await createAppointment(user, await readJson(req));
  return NextResponse.json({ appointment }, { status: 201 });
});
