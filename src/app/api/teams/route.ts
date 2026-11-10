import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { listTeams, saveTeam } from "@/server/services/access-control";

export const GET = apiRoute(async ({ user }) => ({ teams: await listTeams(user) }));
export const POST = apiRoute(async ({ req, user }) => NextResponse.json(await saveTeam(user, null, await readJson(req)), { status: 201 }));
