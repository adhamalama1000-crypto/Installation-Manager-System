import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { complaintsForAppointment, openComplaint } from "@/server/services/complaints";

export const GET = apiRoute(async ({ user, params }) => ({ items: await complaintsForAppointment(user, params.id!) }));

export const POST = apiRoute(async ({ req, user, params }) => {
  const complaint = await openComplaint(user, params.id!, await readJson(req));
  return NextResponse.json({ complaint }, { status: 201 });
});
