import { beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listAppts, POST as createAppt } from "@/app/api/appointments/route";
import { GET as exportCsv } from "@/app/api/reports/export/route";
import { hashPassword } from "@/server/auth/password";
import { appointmentPayload, makeUser, resetDb, seedStatuses } from "../helpers";

/**
 * Since Next.js 16.4.5, route-handler responses lose their Content-Encoding header
 * (GHSA-pc58-hwjq-p385) and `next start` compresses them itself. A body the app gzipped on its own
 * would therefore reach the browser gzipped twice and fail to parse. API routes must return plain
 * bodies without Content-Encoding, even when the client accepts gzip.
 */
const BASE = "http://localhost:3000";
const noParams = { params: Promise.resolve({}) };

function req(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { host: "localhost:3000", "accept-encoding": "gzip, deflate, br" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

let cookie: string;

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  const passwordHash = await hashPassword("Password123");
  await makeUser("ADMIN", { email: "admin@test.local", passwordHash });
  const res = await login(req("/api/auth/login", { method: "POST", body: { email: "admin@test.local", password: "Password123" } }));
  expect(res.status).toBe(200);
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

describe("API responses are not compressed by the app (Next.js compresses them once)", () => {
  it("returns plain JSON for a large GET, with an ETag and without Content-Encoding", async () => {
    for (let i = 0; i < 6; i++) {
      const created = await createAppt(req("/api/appointments", { method: "POST", cookie, body: appointmentPayload({ startTime: `${10 + i}:00`, durationMinutes: 30 }) }), noParams);
      expect(created.status).toBeLessThan(300);
    }
    const res = await listAppts(req("/api/appointments?pageSize=50", { cookie }), noParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("etag")).toBeTruthy();
    const text = await res.text();
    expect(text.length).toBeGreaterThan(1024); // above the size the old app-side gzip kicked in at
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("returns plain JSON for a POST and plain CSV for an export", async () => {
    const post = await createAppt(req("/api/appointments", { method: "POST", cookie, body: appointmentPayload() }), noParams);
    expect(post.status).toBeLessThan(300);
    expect(post.headers.get("content-encoding")).toBeNull();
    const body = (await post.json()) as Record<string, unknown>;
    expect(Object.keys(body).length).toBeGreaterThan(0);

    const csv = await exportCsv(req("/api/reports/export?from=2030-01-01&to=2030-12-31", { cookie }), noParams);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-encoding")).toBeNull();
    expect(csv.headers.get("content-type")).toMatch(/csv/);
  });
});
