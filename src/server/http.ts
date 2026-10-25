import "server-only";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import type { ApiErrorBody } from "@/lib/types";
import { getUserFromRequest, type CurrentUser } from "./auth/session";
import { AppError, ForbiddenError, UnauthorizedError, ValidationError } from "./errors";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_BODY_BYTES = 1_000_000;

type RouteContext = { params: Promise<Record<string, string>> };

export function errorResponse(error: unknown): NextResponse<ApiErrorBody> {
  if (error instanceof AppError) {
    const details = (error.details ?? {}) as { fieldErrors?: Record<string, string>; conflicts?: ApiErrorBody["error"]["conflicts"] };
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(details.fieldErrors ? { fieldErrors: details.fieldErrors } : {}),
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
    { error: { code: "INTERNAL_ERROR", message: `Something went wrong on the server (ref ${ref}). Please try again.` } },
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
    throw new ForbiddenError("Invalid request origin.");
  }
  if (!host || originHost !== host) throw new ForbiddenError("Cross-site requests are not allowed.");
}

export async function readJson(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw new ValidationError({ _form: "Expected a JSON request body." }, "Expected a JSON request body.");
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ValidationError({ _form: "Request body too large." }, "Request body too large.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError({ _form: "Malformed JSON." }, "Malformed JSON.");
  }
}

type Handler = (args: { req: Request; user: CurrentUser; params: Record<string, string> }) => Promise<unknown>;

/** Wraps an authenticated API route: session check, origin check, JSON + error handling. */
export function apiRoute(handler: Handler) {
  return async (req: Request, ctx: RouteContext): Promise<Response> => {
    try {
      assertSameOrigin(req);
      const user = await getUserFromRequest(req);
      if (!user) throw new UnauthorizedError();
      const params = ctx?.params ? await ctx.params : {};
      const result = await handler({ req, user, params });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return errorResponse(error);
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
      return errorResponse(error);
    }
  };
}
