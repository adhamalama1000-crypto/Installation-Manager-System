/**
 * Attachment uploads are authorised before the body is read, and the body is read within bounds
 * (audit M6): size limit, idle timeout, aborts answered as such, and a per-process memory budget
 * for uploads in progress. Refused uploads write no file and no database row.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { POST as upload } from "@/app/api/appointments/[id]/attachments/route";
import { POST as login } from "@/app/api/auth/login/route";
import { createAppointment } from "@/server/services/appointments";
import { hashPassword } from "@/server/auth/password";
import { resetHashPoolForTests } from "@/server/auth/hash-pool";
import { MAX_UPLOAD_BYTES, uploadBytesInFlight } from "@/server/storage";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

const PASSWORD = "Password123";
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];
let dir: string;
let sales: User, outsider: User;
let apptId: string;
let salesCookie: string, outsiderCookie: string;

async function cookieFor(email: string) {
  const res = await login(new Request("http://localhost:3000/api/auth/login", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) }));
  expect(res.status).toBe(200);
  return res.headers.getSetCookie().find((c) => c.startsWith("ims_session="))!.split(";")[0]!;
}

type StreamOpts = { chunk?: number; total?: number; delayMs?: number; failAfter?: number; stallAfter?: number };
/** A request body stream that counts what the server pulled from it. */
function body(opts: StreamOpts) {
  const chunk = opts.chunk ?? 64 * 1024;
  const total = opts.total ?? chunk;
  const stats = { pulled: 0, cancelled: false };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (opts.failAfter !== undefined && sent >= opts.failAfter) return c.error(new Error("client aborted"));
      if (opts.stallAfter !== undefined && sent >= opts.stallAfter) return new Promise(() => undefined);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (sent >= total) return c.close();
      const n = Math.min(chunk, total - sent);
      const bytes = new Uint8Array(n);
      if (sent === 0) bytes.set(JPEG_HEAD);
      sent += n;
      stats.pulled = sent;
      c.enqueue(bytes);
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { stream, stats };
}

function uploadReq(cookie: string, kind: string, b: ReadableStream<Uint8Array> | Uint8Array, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000/api/appointments/${apptId}/attachments?kind=${kind}`, {
    method: "POST",
    headers: { host: "localhost:3000", cookie, "content-type": "application/octet-stream", ...headers },
    body: b as BodyInit,
    // @ts-expect-error Node needs this for stream bodies
    duplex: "half",
  });
}
const params = () => ({ params: Promise.resolve({ id: apptId }) });
const files = async () => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((f) => f.isFile()).length;

const ENV = ["UPLOAD_MAX_INFLIGHT_MB", "UPLOAD_IDLE_TIMEOUT_MS", "UPLOAD_TOTAL_TIMEOUT_MS"];

beforeEach(async () => {
  for (const k of ENV) delete process.env[k];
  await resetHashPoolForTests();
  await resetDb();
  await seedStatuses();
  dir = await mkdtemp(path.join(os.tmpdir(), "ims-upload-limits-"));
  process.env.UPLOAD_DIR = dir;
  const passwordHash = await hashPassword(PASSWORD);
  sales = await makeUser("SALES", { email: "sales@test.local", passwordHash });
  outsider = await makeUser("TECHNICIAN", { email: "outsider@test.local", passwordHash }); // not on the visit: cannot see it
  apptId = (await createAppointment(asCurrent(sales), appointmentPayload())).id;
  salesCookie = await cookieFor(sales.email);
  outsiderCookie = await cookieFor(outsider.email);
});
afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  await rm(dir, { recursive: true, force: true });
});

describe("attachment uploads", () => {
  it("refuses an unauthorised caller before reading the (large) body, writing nothing", async () => {
    const big = body({ total: 50 * 1024 * 1024 });
    const res = await upload(uploadReq(outsiderCookie, "VIDEO", big.stream), params());
    expect(res.status).toBe(404);
    expect(big.stats.pulled).toBeLessThanOrEqual(64 * 1024 * 2); // at most the stream's own pre-fetch, not 50 MB
    expect(big.stats.cancelled).toBe(true);
    // An authenticated caller who sees the visit but may not add this kind: refused the same way.
    await makeUser("VIEWER", { email: "viewer@test.local", passwordHash: await hashPassword(PASSWORD), viewerPermissions: ["appointments.view"] });
    const v = body({ total: 20 * 1024 * 1024 });
    const res2 = await upload(uploadReq(await cookieFor("viewer@test.local"), "AFTER_PHOTO", v.stream), params());
    expect(res2.status).toBe(403);
    expect(v.stats.pulled).toBeLessThanOrEqual(64 * 1024 * 2);
    // Without a session at all: 401, body untouched.
    const anon = body({ total: 20 * 1024 * 1024 });
    expect((await upload(uploadReq("", "BEFORE_PHOTO", anon.stream), params())).status).toBe(401);
    expect(anon.stats.pulled).toBeLessThanOrEqual(64 * 1024 * 2);
    expect(await files()).toBe(0);
    expect(await prisma.attachment.count()).toBe(0);
  });

  it("refuses an unknown kind before reading the body", async () => {
    const b = body({ total: 10 * 1024 * 1024 });
    expect((await upload(uploadReq(salesCookie, "NOT_A_KIND", b.stream), params())).status).toBe(422);
    expect(b.stats.pulled).toBeLessThanOrEqual(64 * 1024 * 2);
  });

  it("accepts an authorised upload within the limit", async () => {
    const b = body({ total: 200 * 1024 });
    const res = await upload(uploadReq(salesCookie, "BEFORE_PHOTO", b.stream), params());
    expect(res.status).toBe(200);
    expect((await res.json()).attachment.kind).toBe("BEFORE_PHOTO");
    expect(await prisma.attachment.count()).toBe(1);
    expect(await files()).toBe(1);
    expect(uploadBytesInFlight()).toBe(0);
  });

  it("refuses a body over the limit (declared or not) without buffering the rest", async () => {
    const declared = body({ total: MAX_UPLOAD_BYTES + 1 });
    const r1 = await upload(uploadReq(salesCookie, "BEFORE_PHOTO", declared.stream, { "content-length": String(MAX_UPLOAD_BYTES + 1) }), params());
    expect(r1.status).toBe(422);
    expect(declared.stats.pulled).toBeLessThanOrEqual(64 * 1024 * 2);
    const chunked = body({ total: 100 * 1024 * 1024 });
    const r2 = await upload(uploadReq(salesCookie, "BEFORE_PHOTO", chunked.stream), params());
    expect(r2.status).toBe(422);
    expect(chunked.stats.pulled).toBeLessThan(MAX_UPLOAD_BYTES + 3 * 64 * 1024);
    expect(chunked.stats.cancelled).toBe(true);
    expect(await files()).toBe(0);
    expect(uploadBytesInFlight()).toBe(0);
  });

  it("refuses an unsupported file type", async () => {
    const res = await upload(uploadReq(salesCookie, "BEFORE_PHOTO", new TextEncoder().encode("<html>not an image</html>")), params());
    expect(res.status).toBe(422);
    expect(await files()).toBe(0);
  });

  it("answers an aborted upload with 400 (not 500), and a malformed Content-Length with 400", async () => {
    const aborted = body({ total: 1024 * 1024, failAfter: 128 * 1024 });
    const r = await upload(uploadReq(salesCookie, "BEFORE_PHOTO", aborted.stream), params());
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("BAD_REQUEST");
    const bad = await upload(uploadReq(salesCookie, "BEFORE_PHOTO", new Uint8Array([...JPEG_HEAD]), { "content-length": "4, 5" }), params());
    expect(bad.status).toBe(400);
    expect(await files()).toBe(0);
    expect(uploadBytesInFlight()).toBe(0);
  });

  it("gives up on a body that stops arriving (408)", async () => {
    process.env.UPLOAD_IDLE_TIMEOUT_MS = "1000";
    const stalled = body({ total: 1024 * 1024, stallAfter: 64 * 1024 });
    const t = Date.now();
    const r = await upload(uploadReq(salesCookie, "BEFORE_PHOTO", stalled.stream), params());
    expect(r.status).toBe(408);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(uploadBytesInFlight()).toBe(0);
  });

  it("keeps simultaneous uploads within the memory budget: the rest get 503 at once", async () => {
    process.env.UPLOAD_MAX_INFLIGHT_MB = "10";
    const size = 4 * 1024 * 1024; // each declares 4 MB: 2 fit in 10 MB
    const uploads = Array.from({ length: 6 }, () => body({ total: size, chunk: 256 * 1024, delayMs: 20 }));
    const rs = await Promise.all(uploads.map((u) => upload(uploadReq(salesCookie, "BEFORE_PHOTO", u.stream, { "content-length": String(size) }), params())));
    const codes = rs.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 200).length).toBeGreaterThanOrEqual(1);
    expect(codes.filter((c) => c === 503).length).toBeGreaterThanOrEqual(3);
    expect(codes.every((c) => c === 200 || c === 503)).toBe(true);
    expect(rs.find((r) => r.status === 503)!.headers.get("retry-after")).toBeTruthy();
    expect(uploadBytesInFlight()).toBe(0);
    expect(await prisma.attachment.count()).toBe(codes.filter((c) => c === 200).length);
  });
});
