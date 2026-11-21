import "server-only";
import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import type { ApiErrorBody } from "@/lib/types";
import { localeFromCookieHeader, type Locale } from "@/i18n/config";
import { createT } from "@/i18n/translator";
import { getUserFromRequest, type CurrentUser } from "./auth/session";
import { clientIp } from "./auth/client-ip";
import { HashPoolBusyError, HashPoolFailureError } from "./auth/hash-pool";
import { AppError, BadRequestError, ForbiddenError, PayloadTooLargeError, RateLimitError, RequestTimeoutError, ServiceUnavailableError, UnauthorizedError, ValidationError } from "./errors";
import { contextFromRequest, runWithRequestContext } from "./request-context";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_BODY_BYTES = 1_000_000;

type RouteContext = { params: Promise<Record<string, string>> };

function retryAfter(error: AppError): Record<string, string> | undefined {
  const seconds = error instanceof RateLimitError || error instanceof ServiceUnavailableError ? error.retryAfterSeconds : undefined;
  return seconds ? { "Retry-After": String(seconds) } : undefined;
}

/** The error as JSON in the requester's language (message keys are translated here). */
export function errorResponse(error: unknown, locale: Locale = "ar"): NextResponse<ApiErrorBody> {
  const t = createT(locale);
  // Password hashing pool full or failing (password changes, user creation): temporary, retry.
  if (error instanceof HashPoolBusyError || error instanceof HashPoolFailureError) error = new ServiceUnavailableError("errors.authBusy", 5);
  if (error instanceof AppError) {
    const details = (error.details ?? {}) as { fieldErrors?: Record<string, string>; conflicts?: ApiErrorBody["error"]["conflicts"] };
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: t.msg(error.raw),
          ...(details.fieldErrors ? { fieldErrors: Object.fromEntries(Object.entries(details.fieldErrors).map(([k, v]) => [k, t.msg(v)])) } : {}),
          ...(details.conflicts ? { conflicts: details.conflicts } : {}),
        },
      },
      { status: error.status, headers: retryAfter(error) },
    );
  }
  // Unknown error: log the details server-side, return a generic message (no stack traces).
  const ref = randomUUID().slice(0, 8);
  console.error(`[api-error ${ref}]`, error);
  return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: t("errors.serverError", { ref }) } }, { status: 500 });
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
    throw new ForbiddenError("errors.badOrigin");
  }
  if (!host || originHost !== host) throw new ForbiddenError("errors.crossSite");
}

export type ReadJsonOptions = { maxBytes?: number; timeoutMs?: number };

function bodyTimeoutMs(): number {
  const n = Number(process.env.JSON_BODY_TIMEOUT_MS);
  return Number.isInteger(n) && n >= 1000 && n <= 600_000 ? n : 60_000;
}

/** Content-Length as a number, null when absent; throws on a malformed or contradictory value. */
function declaredLength(req: Request): number | null {
  const raw = req.headers.get("content-length");
  if (raw === null) return null;
  // Repeated headers arrive joined with ", "; they must all agree.
  const values = new Set(raw.split(",").map((v) => v.trim()));
  if (values.size !== 1) throw new BadRequestError("errors.badContentLength");
  const [v] = [...values] as [string];
  if (!/^\d{1,15}$/.test(v)) throw new BadRequestError("errors.badContentLength");
  return Number(v);
}

/**
 * Reads a JSON body of at most `maxBytes` (1 MB) without ever holding more than that in memory.
 *
 * Content-Length is checked first (a larger declared size is refused before reading anything),
 * but it is not trusted: the body is streamed and counted, so a missing or false Content-Length or
 * a chunked body is cut off as soon as it passes the limit. A body that does not finish arriving
 * within JSON_BODY_TIMEOUT_MS (default 60 s) is refused, and a body cut short by the client is
 * refused. In every refusal the stream is cancelled so nothing more is buffered.
 *
 * Errors: 422 expectedJson (wrong content type, unchanged), 413 bodyTooLarge,
 * 400 badContentLength / bodyIncomplete, 408 bodyTimeout, 422 malformedJson.
 */
export async function readJson(req: Request, opts: ReadJsonOptions = {}): Promise<unknown> {
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  const timeoutMs = opts.timeoutMs ?? bodyTimeoutMs();
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    void req.body?.cancel().catch(() => undefined);
    throw new ValidationError({ _form: "errors.expectedJson" }, "errors.expectedJson");
  }
  let declared: number | null;
  try {
    declared = declaredLength(req);
    if (declared !== null && declared > maxBytes) throw new PayloadTooLargeError();
  } catch (e) {
    void req.body?.cancel().catch(() => undefined);
    throw e;
  }
  if (!req.body) return {};

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestTimeoutError()), timeoutMs);
  });
  try {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await Promise.race([reader.read(), deadline]);
      } catch (e) {
        if (e instanceof AppError) throw e;
        // The client went away or the connection broke mid-body.
        throw new BadRequestError("errors.bodyIncomplete");
      }
      if (step.done) break;
      total += step.value.byteLength;
      if (total > maxBytes) throw new PayloadTooLargeError();
      chunks.push(step.value);
    }
  } catch (e) {
    reader.cancel().catch(() => undefined);
    throw e;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  if (declared !== null && total !== declared) throw new BadRequestError("errors.bodyIncomplete");
  if (total === 0) return {};
  const text = new TextDecoder().decode(Buffer.concat(chunks, total));
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError({ _form: "errors.malformedJson" }, "errors.malformedJson");
  }
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
    const locale = localeFromCookieHeader(req.headers.get("cookie"));
    try {
      assertSameOrigin(req);
      const user = await getUserFromRequest(req);
      if (!user) throw new UnauthorizedError();
      const params = ctx?.params ? await ctx.params : {};
      // Every audit entry written while the handler runs records who called it and how.
      const result = await runWithRequestContext(contextFromRequest(req, clientIp(req)), () => handler({ req, user, params }));
      // Compression is left to Next.js: since 16.4.5 it removes Content-Encoding from route-handler
      // responses (GHSA-pc58-hwjq-p385), so a body gzipped here would be sent gzipped twice.
      // `next start` gzips JSON and CSV responses itself when the client accepts it.
      if (result instanceof Response) return result;
      if (req.method === "GET") return jsonWithEtag(req, result ?? { ok: true });
      return NextResponse.json(result ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return errorResponse(error, locale);
    }
  };
}

/** For unauthenticated endpoints (login, set password). */
export function publicRoute(handler: (args: { req: Request; locale: Locale }) => Promise<unknown>) {
  return async (req: Request): Promise<Response> => {
    const locale = localeFromCookieHeader(req.headers.get("cookie"));
    try {
      assertSameOrigin(req);
      const result = await runWithRequestContext(contextFromRequest(req, clientIp(req)), () => handler({ req, locale }));
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return errorResponse(error, locale);
    }
  };
}
