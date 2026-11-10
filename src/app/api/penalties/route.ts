import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { listViolations, recordViolation } from "@/server/services/penalties";

/** ?status=&userId=&month=YYYY-MM&page= (employees with only penalties.own see their own decided ones). */
export const GET = apiRoute(async ({ req, user }) => {
  const q = new URL(req.url).searchParams;
  return listViolations(user, { status: q.get("status") ?? undefined, userId: q.get("userId") ?? undefined, month: q.get("month") ?? undefined, page: q.get("page") });
});

/** Body: { userId, ruleId?, occurredOn, kind: WARNING | DEDUCTION, amount, description, appointmentId? }. Proposed only. */
export const POST = apiRoute(async ({ req, user }) => NextResponse.json({ violation: await recordViolation(user, await readJson(req)) }, { status: 201 }));
