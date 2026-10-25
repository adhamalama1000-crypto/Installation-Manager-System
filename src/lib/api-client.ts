"use client";

import type { ApiErrorBody, ConflictDTO } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly fieldErrors: Record<string, string> = {},
    public readonly conflicts: ConflictDTO[] = [],
  ) {
    super(message);
  }
}

type ApiOptions = { method?: string; body?: unknown; signal?: AbortSignal; ifNoneMatch?: string | null };

async function send(path: string, options: ApiOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.ifNoneMatch) headers["If-None-Match"] = options.ifNoneMatch;
  try {
    return await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("Could not reach the server. Check your connection and try again.", 0, "NETWORK_ERROR");
  }
}

/**
 * GET that tells the server which version the caller already has. Returns `null` data when it is
 * unchanged (HTTP 304), so polling callers can skip parsing and re-rendering.
 */
export async function apiIfChanged<T>(path: string, etag: string | null, signal?: AbortSignal): Promise<{ data: T | null; etag: string | null }> {
  const res = await send(path, { signal, ifNoneMatch: etag });
  if (res.status === 304) return { data: null, etag };
  return { data: await parse<T>(res, path), etag: res.headers.get("etag") };
}

/** JSON fetch wrapper for the app's API routes. Throws ApiError with server-provided details. */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  return parse<T>(await send(path, options), path);
}

async function parse<T>(res: Response, path: string): Promise<T> {
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth/")) {
    // Session expired: full reload to the sign-in page (clears stale client state).
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(
      err?.message ?? `Request failed (${res.status}).`,
      res.status,
      err?.code ?? "UNKNOWN",
      err?.fieldErrors ?? {},
      err?.conflicts ?? [],
    );
  }
  return data as T;
}
