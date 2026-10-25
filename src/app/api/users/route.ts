import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { createUser, listUsers } from "@/server/services/users";

export const GET = apiRoute(async ({ user }) => ({ users: await listUsers(user) }));

export const POST = apiRoute(async ({ req, user }) => NextResponse.json(await createUser(user, await readJson(req)), { status: 201 }));
