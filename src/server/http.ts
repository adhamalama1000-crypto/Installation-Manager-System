import "server-only";
import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import type { ApiErrorBody } from "@/lib/types";
import { getUserFromRequest, type CurrentUser } from "./auth/session";
import { AppError, ForbiddenError, UnauthorizedError, ValidationError } from "./errors";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { localeFromRequest } from "@/i18n/server";
import { msg, translate, translateFieldErrors, translateMessage } from "@/i18n/translate";
import { DEFAULT_TIMEZONE } from "@/lib/constants";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_BODY_BYTES = 1_000_000;

type RouteContext = { params: Promise<Record<string, string>> };

export function errorResponse(error: unknown, locale: Locale = DEFAULT_LOCALE, tz = DEFAULT_TIMEZONE): NextResponse<ApiErrorBody> {
  if (error instanceof AppError) {
    const details = (error.details ?? {}) as { fieldErrors?: Record<string, string>; conflicts?: ApiErrorBody["error"]["conflicts"] };
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: translateMessage(error.descriptor, locale, tz),
          ...(details.fieldErrors ? { fieldErrors: translateFieldErrors(details.fieldErrors, locale, tz) } : {}),
          ...(details.conflicts ? { conflicts: details.conflicts } : {}),
        },
      },
      { status: error.status },
    );
  }
  // Unknown error: log the details server-side, return a generic message (no stack traces).
  const ref = randomUUID().slice(0, 8);
  console.error(`[api-error ${ref}]`, error);
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: translate(locale, "e.internal", { ref }) } },
    { status: 500 },
  );
}

/**
 * Rejects cross-site state-changing requests. Session cookies are SameSite=Lax already; this is a
 * second layer that also covers same-site subdomains.
 */
export function assertSameOrigin(req: Request) {
  if (!MUTATING.has(req.method)) return;
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser clients (curl, tests) do not send Origin
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ForbiddenError(msg("e.invalidOrigin"));
  }
  if (!host || originHost !== host) throw new ForbiddenError(msg("e.crossSite"));
}

export async function readJson(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw new ValidationError({ _form: msg("e.expectedJson") }, msg("e.expectedJson"));
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ValidationError({ _form: msg("e.bodyTooLarge") }, msg("e.bodyTooLarge"));
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError({ _form: msg("e.malformedJson") }, msg("e.malformedJson"));
  }
}

const gzip = promisify(gzipCallback);
const COMPRESS_MIN_BYTES = 1024;

/**
 * `next start` compresses rendered pages but not route-handler responses, so a month of calendar
 * events (~1 MB of JSON) or a CSV export went over the network uncompressed. Compresses JSON/CSV
 * bodies off the main thread when the client accepts gzip.
 */
async function compressed(req: Request, res: Response): Promise<Response> {
  if (!/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) return res;
  if (!res.body || res.status === 304 || res.headers.has("content-encoding")) return res;
  if (!/json|csv/.test(res.headers.get("content-type") ?? "")) return res;
  const body = Buffer.from(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  headers.append("Vary", "Accept-Encoding");
  if (body.byteLength < COMPRESS_MIN_BYTES) return new Response(body, { status: res.status, headers });
  headers.set("Content-Encoding", "gzip");
  headers.delete("Content-Length");
  return new Response(new Uint8Array(await gzip(body)), { status: res.status, headers });
}

/**
 * JSON response for a GET with an ETag of its content. When the client already has exactly this
 * content (If-None-Match), answers 304 without a body. The data is always read fresh from the
 * database first, so this never serves stale data; it only avoids re-sending unchanged bytes.
 */
function jsonWithEtag(req: Request, data: unknown): Response {
  const body = JSON.stringify(data);
  const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
  const headers = { "Cache-Control": "no-store", ETag: etag, "Content-Type": "application/json" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}

type Handler = (args: { req: Request; user: CurrentUser; params: Record<string, string> }) => Promise<unknown>;

/** Wraps an authenticated API route: session check, origin check, JSON + error handling. */
export function apiRoute(handler: Handler) {
  return async (req: Request, ctx: RouteContext): Promise<Response> => {
    let user: CurrentUser | null = null;
    try {
      assertSameOrigin(req);
      user = await getUserFromRequest(req);
      if (!user) throw new UnauthorizedError();
      const params = ctx?.params ? await ctx.params : {};
      const result = await handler({ req, user, params });
      if (result instanceof Response) return await compressed(req, result);
      if (req.method === "GET") return await compressed(req, jsonWithEtag(req, result ?? { ok: true }));
      return await compressed(req, NextResponse.json(result ?? { ok: true }, { headers: { "Cache-Control": "no-store" } }));
    } catch (error) {
      return errorResponse(error, localeFromRequest(req, user?.locale), user?.settings.timezone);
    }
  };
}

/** For unauthenticated endpoints (login, set password). */
export function publicRoute(handler: (args: { req: Request }) => Promise<unknown>) {
  return async (req: Request): Promise<Response> => {
    try {
      assertSameOrigin(req);
      const result = await handler({ req });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return errorResponse(error, localeFromRequest(req));
    }
  };
}
