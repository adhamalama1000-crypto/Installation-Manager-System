/**
 * Malformed and forged cookies (Batch 1.2 Phase A: R7, A1, R6). A cookie value that is not valid URI
 * encoding is treated as absent everywhere (device, session, locale, logout) and never turns into a
 * 500 or a false "limits unavailable" 503. Device tokens that do not have the shape of a token we
 * issue are refused without a database lookup. Valid cookies behave exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@prisma/client";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as setLocale } from "@/app/api/me/locale/route";
import { GET as listAppts } from "@/app/api/appointments/route";
import { hashPassword } from "@/server/auth/password";
import { resetHashPoolForTests } from "@/server/auth/hash-pool";
import { resetCleanupScheduleForTests } from "@/server/auth/rate-limit";
import { DEVICE_COOKIE } from "@/server/auth/devices";
import { cookieFromHeader } from "@/server/auth/session";
import { isRandomToken, randomToken } from "@/server/auth/crypto";
import { makeUser, prisma, resetDb, seedStatuses } from "../helpers";

const PASSWORD = "Password123";
const WRONG = "Wrong-Password-9";
const MALFORMED = "%E0%A4%A"; // not valid URI encoding: decodeURIComponent throws on it
const noParams = { params: Promise.resolve({}) };
let hash: string;
let user: User;

const post = (path: string, body: unknown, cookie?: string) =>
  new Request(`http://localhost:3000${path}`, { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const signIn = (password: string, cookie?: string) => login(post("/api/auth/login", { email: user.email, password }, cookie));
const setCookieOf = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const valueOf = (res: Response, name: string) => setCookieOf(res, name)?.split(";")[0];
/** console.error lines that mean "the limits could not be reached" or an unhandled API error. */
const alarms = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes("limits unavailable") || l.includes("[api-error"));

beforeEach(async () => {
  await resetHashPoolForTests();
  resetCleanupScheduleForTests();
  await resetDb();
  await seedStatuses();
  hash ??= await hashPassword(PASSWORD);
  user = await makeUser("SALES", { email: "cookie@test.local", passwordHash: hash });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the shared cookie parser", () => {
  it("decodes valid values as before and treats malformed ones as absent", () => {
    expect(cookieFromHeader("a=1; b=x%20y; c=p=q", "b")).toBe("x y");
    expect(cookieFromHeader("a=1; b=x%20y; c=p=q", "c")).toBe("p=q");
    expect(cookieFromHeader("a=1", "b")).toBeNull();
    expect(cookieFromHeader(null, "a")).toBeNull();
    expect(cookieFromHeader(`a=${MALFORMED}; b=ok`, "a")).toBeNull();
    expect(cookieFromHeader(`a=${MALFORMED}; b=ok`, "b")).toBe("ok"); // other cookies still readable
    expect(cookieFromHeader("a=; b=ok", "a")).toBe(""); // empty stays empty (callers treat it as absent)
  });

  it("recognises exactly the shape of tokens randomToken() issues", () => {
    for (let i = 0; i < 500; i++) expect(isRandomToken(randomToken())).toBe(true);
    const t = randomToken();
    for (const bad of ["", t.slice(1), `${t}A`, `${t.slice(0, 42)}+`, `${t.slice(0, 42)}/`, `${t.slice(0, 42)}=`, `${t.slice(0, 42)}.`, " ".repeat(43), "x".repeat(100)]) {
      expect(isRandomToken(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("malformed ims_device (R7)", () => {
  it("is treated as no device: no URIError, no false 'limits unavailable', no lookup", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const find = vi.spyOn(prisma.loginDevice, "findUnique");
    const ok = await signIn(PASSWORD, `${DEVICE_COOKIE}=${MALFORMED}`);
    expect(ok.status).toBe(200);
    expect(valueOf(ok, "ims_session")).toBeTruthy();
    expect(valueOf(ok, DEVICE_COOKIE)).toMatch(new RegExp(`^${DEVICE_COOKIE}=[A-Za-z0-9_-]{43}$`)); // a fresh, real token
    expect((await signIn(WRONG, `${DEVICE_COOKIE}=${MALFORMED}`)).status).toBe(401); // a normal failure, not 503
    expect(find).not.toHaveBeenCalled();
    expect(alarms(errors)).toEqual([]);
  });
});

describe("forged device tokens (R6)", () => {
  it("of the wrong shape cause zero device lookups and behave as an unknown device", async () => {
    const find = vi.spyOn(prisma.loginDevice, "findUnique");
    const t = randomToken();
    const forged = ["made-up-token", t.slice(1), `${t}A`, `${t.slice(0, 42)}+`, encodeURIComponent(`${t.slice(0, 42)}/`), "x".repeat(99), ""];
    // Unknown-device lane throughout: the first 5 failures are checked (401), then the account is
    // locked for unknown devices (429), whatever forged value is sent.
    const codes = [];
    for (const value of forged) codes.push((await signIn(WRONG, `${DEVICE_COOKIE}=${value}`)).status);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429]);
    expect((await signIn(PASSWORD, `${DEVICE_COOKIE}=made-up-token`)).status).toBe(429);
    expect(find).not.toHaveBeenCalled();
  });

  it("of the right shape are looked up once and, not being ours, follow the unknown-device path", async () => {
    const find = vi.spyOn(prisma.loginDevice, "findUnique");
    const forged = randomToken(); // correct shape, never issued
    for (let i = 0; i < 5; i++) expect((await signIn(WRONG, `${DEVICE_COOKIE}=${forged}`)).status).toBe(401);
    expect(find).toHaveBeenCalledTimes(5);
    // Not a known device: the account's unknown-device lock applies to it.
    expect((await signIn(PASSWORD, `${DEVICE_COOKIE}=${forged}`)).status).toBe(429);
    expect(await prisma.loginDevice.count()).toBe(0);
  });
});

describe("malformed ims_session (A1)", () => {
  it("on an authenticated API route answers 401 like no session, not 500", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await listAppts(new Request("http://localhost:3000/api/appointments", { headers: { host: "localhost:3000", cookie: `ims_session=${MALFORMED}` } }), noParams);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
    expect(alarms(errors)).toEqual([]);
  });

  it("on me/locale is treated as signed out: the cookie is set, no preference saved, no 500", async () => {
    const res = await setLocale(post("/api/me/locale", { locale: "en" }, `ims_session=${MALFORMED}`));
    expect(res.status).toBe(200);
    expect(valueOf(res, "ims_locale")).toBe("ims_locale=en");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).locale).toBe(user.locale);
  });
});

describe("malformed ims_locale during a valid sign-in (A1)", () => {
  it("signs in normally: 200, session and device cookies issued, exactly one session/device/audit entry", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await prisma.user.update({ where: { id: user.id }, data: { locale: "en" } });
    const res = await signIn(PASSWORD, `ims_locale=${MALFORMED}`);
    expect(res.status).toBe(200);
    expect(valueOf(res, "ims_session")).toBeTruthy();
    expect(valueOf(res, DEVICE_COOKIE)).toBeTruthy();
    // No valid language chosen in this browser: the saved preference comes back, as for a missing cookie.
    expect(valueOf(res, "ims_locale")).toBe("ims_locale=en");
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.loginDevice.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_SUCCEEDED", actorId: user.id } })).toBe(1);
    expect(alarms(errors)).toEqual([]);
  });
});

describe("logout with malformed cookies (A1)", () => {
  it("with a malformed session cookie: 200, the session cookie is cleared, nothing deleted or audited", async () => {
    const live = valueOf(await signIn(PASSWORD), "ims_session")!;
    const res = await logout(post("/api/auth/logout", {}, `ims_session=${MALFORMED}`));
    expect(res.status).toBe(200);
    expect(setCookieOf(res, "ims_session")).toMatch(/Max-Age=0/i);
    expect(await prisma.session.count()).toBe(1); // the real session elsewhere is untouched
    expect(await prisma.auditLog.count({ where: { action: "LOGOUT" } })).toBe(0);
    // ...and that real session still authenticates.
    const still = await listAppts(new Request("http://localhost:3000/api/appointments", { headers: { host: "localhost:3000", cookie: live } }), noParams);
    expect(still.status).toBe(200);
  });

  it("with a valid session and malformed device/locale cookies: the session ends and is audited as before", async () => {
    const session = valueOf(await signIn(PASSWORD), "ims_session")!;
    const res = await logout(post("/api/auth/logout", {}, `${DEVICE_COOKIE}=${MALFORMED}; ${session}; ims_locale=${MALFORMED}`));
    expect(res.status).toBe(200);
    expect(setCookieOf(res, "ims_session")).toMatch(/Max-Age=0/i);
    expect(await prisma.session.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "LOGOUT", actorId: user.id } })).toBe(1);
  });
});

describe("valid cookies are unchanged", () => {
  it("session, locale and device cookies keep working exactly as before", async () => {
    const first = await signIn(PASSWORD, "ims_locale=ar");
    expect(first.status).toBe(200);
    expect(valueOf(first, "ims_locale")).toBeUndefined(); // a language chosen in this browser stays
    const session = valueOf(first, "ims_session")!;
    const device = valueOf(first, DEVICE_COOKIE)!;
    // A valid session authenticates an API call.
    const list = await listAppts(new Request("http://localhost:3000/api/appointments", { headers: { host: "localhost:3000", cookie: session } }), noParams);
    expect(list.status).toBe(200);
    // A valid device token is looked up and kept (same token refreshed), and still gets the known-device lane.
    const find = vi.spyOn(prisma.loginDevice, "findUnique");
    const again = await signIn(PASSWORD, device);
    expect(again.status).toBe(200);
    expect(valueOf(again, DEVICE_COOKIE)).toBe(device);
    expect(find).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 6; i++) await signIn(WRONG); // lock the account for unknown devices
    expect((await signIn(PASSWORD)).status).toBe(429);
    expect((await signIn(PASSWORD, device)).status).toBe(200);
    // Logout with a valid session still ends it.
    expect((await logout(post("/api/auth/logout", {}, session))).status).toBe(200);
    expect(await prisma.session.findMany({ where: { userId: user.id } })).toHaveLength(2); // the two later sign-ins remain
  });
});
