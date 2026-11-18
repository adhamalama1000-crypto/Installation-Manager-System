import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

/**
 * Liveness and database check for the Windows launcher and monitoring. Public on purpose and
 * reveals nothing but up/down: no version, configuration, counts or error text.
 *   200 {"app":"or-vip-erp","status":"ok","database":"ok"}
 *   503 {"app":"or-vip-erp","status":"degraded","database":"unreachable"}
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ app: "or-vip-erp", status: "ok", database: "ok" }, { headers });
  } catch {
    return NextResponse.json({ app: "or-vip-erp", status: "degraded", database: "unreachable" }, { status: 503, headers });
  }
}
