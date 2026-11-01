import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { addExpense, listExpenses } from "@/server/services/expenses";

export const GET = apiRoute(async ({ req, user }) => listExpenses(user, new URL(req.url).searchParams.get("month") ?? undefined));

/** Body: { amount, appointmentId?, note? }. */
export const POST = apiRoute(async ({ req, user }) => NextResponse.json({ expense: await addExpense(user, await readJson(req)) }, { status: 201 }));
