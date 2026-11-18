import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";
import { prisma } from "../helpers";

describe("GET /api/health (used by the Windows launcher)", () => {
  it("reports the app and a reachable database", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ app: "or-vip-erp", status: "ok", database: "ok" });
  });

  it("answers 503 without any error detail when the database is unreachable", async () => {
    const spy = vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("connect ECONNREFUSED postgresql://ims:secret@db:5432"));
    const res = await GET();
    spy.mockRestore();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ app: "or-vip-erp", status: "degraded", database: "unreachable" });
    expect(text).not.toContain("secret");
  });
});
