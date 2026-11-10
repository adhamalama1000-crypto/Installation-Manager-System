import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/** Who made the request and how (recorded with every audit entry written while it runs). Never credentials. */
export type RequestContext = { ip: string | null; userAgent: string | null; method: string; path: string };

const storage = new AsyncLocalStorage<RequestContext>();

export function contextFromRequest(req: Request, ip: string | null): RequestContext {
  let path = "";
  try {
    path = new URL(req.url).pathname;
  } catch {
    path = "";
  }
  return { ip, userAgent: (req.headers.get("user-agent") ?? "").slice(0, 300) || null, method: req.method, path: path.slice(0, 300) };
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentRequestContext(): RequestContext | null {
  return storage.getStore() ?? null;
}
