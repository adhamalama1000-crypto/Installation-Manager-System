import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runLateCheck } from "@/server/services/field";

/**
 * Late alerts (Aura lateCheck), for a scheduler to call every 15 minutes:
 *   curl -X POST -H "Authorization: Bearer %CRON_SECRET%" https://your-app/api/cron/late-check
 * Refused unless CRON_SECRET is set (at least 16 characters) and matches.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < 16) return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "Set CRON_SECRET to enable late alerts." } }, { status: 503 });
  const given = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Wrong or missing CRON_SECRET." } }, { status: 401 });
  }
  const result = await runLateCheck();
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
