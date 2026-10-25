import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { listModels, saveModel } from "@/server/services/stock";

export const GET = apiRoute(async ({ user }) => ({ models: await listModels(user) }));

export const POST = apiRoute(async ({ req, user }) => NextResponse.json(await saveModel(user, null, await readJson(req)), { status: 201 }));
