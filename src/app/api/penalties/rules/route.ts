import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { listPenaltyRules, savePenaltyRule } from "@/server/services/penalties";

export const GET = apiRoute(async ({ user }) => ({ rules: await listPenaltyRules(user) }));
export const POST = apiRoute(async ({ req, user }) => NextResponse.json({ rule: await savePenaltyRule(user, null, await readJson(req)) }, { status: 201 }));
