import { NextResponse } from "next/server";
import { apiRoute, readJson } from "@/server/http";
import { createAccessRole, listAccessRoles } from "@/server/services/access-roles";

/** Built-in roles with their defaults, and every custom role (Admin). */
export const GET = apiRoute(async ({ user }) => listAccessRoles(user));

/** Body: { name, nameAr?, description?, baseRole, permissions?, scopes?, reason? } (Admin). */
export const POST = apiRoute(async ({ req, user }) => NextResponse.json(await createAccessRole(user, await readJson(req)), { status: 201 }));
