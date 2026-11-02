/**
 * The session cookie must reach the browser in every way the app is opened. It used to be marked
 * Secure whenever NODE_ENV was production and APP_URL did not start with http://, so the
 * production build opened over plain http at the machine's network address (or name) had its
 * session cookie dropped by the browser: sign-in answered 200 and the next page went back to
 * /login. `Secure` now follows the request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as notifications } from "@/app/api/notifications/route";
import { hashPassword } from "@/server/auth/password";
import { isSecureRequest } from "@/server/auth/session";
import { makeUser, resetDb } from "../helpers";

const PASSWORD = "Password123";
const noParams = { params: Promise.resolve({}) };

function post(url: string, headers: Record<string, string> = {}, body: unknown = { email: "admin@test.local", password: PASSWORD }) {
  const u = new URL(url);
  return new Request(url, { method: "POST", headers: { host: u.host, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const sessionCookieOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("ims_session="))!;

beforeEach(async () => {
  await resetDb();
  await makeUser("ADMIN", { email: "admin@test.local", passwordHash: await hashPassword(PASSWORD) });
  // The configuration that broke sign-in: the production build with an https public address.
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_URL", "https://ims.example.com");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session cookie", () => {
  it("is not Secure on plain http at a network address, and signs the browser in", async () => {
    const res = await login(post("http://192.168.1.20:3001/api/auth/login"));
    expect(res.status).toBe(200);
    const cookie = sessionCookieOf(res);
    expect(cookie).not.toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    // A relative lifetime (12 hours by default), so a server clock that lags cannot expire it on arrival.
    const maxAge = Number(cookie.match(/Max-Age=(\d+)/i)?.[1]);
    expect(maxAge).toBeGreaterThan(11 * 3600);
    expect(maxAge).toBeLessThanOrEqual(12 * 3600);
    // The cookie the browser keeps opens the next request.
    const token = cookie.split(";")[0]!;
    const next = await notifications(new Request("http://192.168.1.20:3001/api/notifications", { headers: { host: "192.168.1.20:3001", cookie: token } }), noParams);
    expect(next.status).toBe(200);
  });

  it("is not Secure on http://localhost either, even with an https APP_URL", async () => {
    expect(sessionCookieOf(await login(post("http://localhost:3001/api/auth/login")))).not.toMatch(/;\s*Secure/i);
    vi.stubEnv("APP_URL", "");
    expect(sessionCookieOf(await login(post("http://localhost:3001/api/auth/login")))).not.toMatch(/;\s*Secure/i);
  });

  it("is Secure when the browser came over HTTPS: via a proxy header or the public https host", async () => {
    expect(sessionCookieOf(await login(post("http://10.0.0.5:3000/api/auth/login", { "x-forwarded-proto": "https" })))).toMatch(/;\s*Secure/i);
    // A proxy that keeps the public host but does not say https.
    expect(sessionCookieOf(await login(post("http://ims.example.com/api/auth/login")))).toMatch(/;\s*Secure/i);
    expect(sessionCookieOf(await login(post("http://internal:3000/api/auth/login", { "x-forwarded-host": "ims.example.com" })))).toMatch(/;\s*Secure/i);
  });

  it("is cleared on sign-out with the same rule", async () => {
    const res = await logout(post("http://192.168.1.20:3001/api/auth/logout", {}, {}));
    const cleared = sessionCookieOf(res);
    expect(cleared).toMatch(/Max-Age=0/i);
    expect(cleared).not.toMatch(/;\s*Secure/i);
    expect(sessionCookieOf(await logout(post("http://10.0.0.5:3000/api/auth/logout", { "x-forwarded-proto": "https" }, {})))).toMatch(/;\s*Secure/i);
  });
});

describe("isSecureRequest", () => {
  const r = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
  it("follows the request, not NODE_ENV", () => {
    expect(isSecureRequest(r("https://anything.example/x"))).toBe(true);
    expect(isSecureRequest(r("http://192.168.1.20:3001/x"))).toBe(false);
    expect(isSecureRequest(r("http://x/", { "x-forwarded-proto": "https, http" }))).toBe(true);
    expect(isSecureRequest(r("http://x/", { "x-forwarded-proto": "http" }))).toBe(false);
    expect(isSecureRequest(r("http://ims.example.com/x", { host: "ims.example.com" }))).toBe(true);
    vi.stubEnv("APP_URL", "http://ims.example.com");
    expect(isSecureRequest(r("http://ims.example.com/x", { host: "ims.example.com" }))).toBe(false);
  });
});
