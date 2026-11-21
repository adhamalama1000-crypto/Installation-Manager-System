import { isIP } from "node:net";

/**
 * The client's address, taken ONLY from proxies the operator declares trusted.
 *
 * TRUSTED_PROXY_HOPS is the number of reverse proxies in front of the app that append to
 * X-Forwarded-For (nginx `proxy_add_x_forwarded_for`, IIS ARR, Caddy, a load balancer...):
 *   - 0 (default): forwarding headers are ignored completely and the address is "unknown". Anyone
 *     can write X-Forwarded-For, so without a trusted proxy it says nothing about the client.
 *   - N >= 1: the client is the Nth entry from the RIGHT, the one the outermost trusted proxy wrote.
 *     Entries further left were sent by the client and are never used.
 * X-Real-IP and other headers are never trusted. A list shorter than N (the request did not come
 * through all the proxies), or an entry that is not an IP address, gives "unknown".
 *
 * The app cannot see the TCP peer address (Next.js route handlers do not expose it), so without a
 * trusted proxy per-address limits are off and only per-account and global limits apply.
 */
export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 0;
}

export const UNKNOWN_ADDRESS = "unknown";

/** Normalises one X-Forwarded-For entry to a bare IP address, or null when it is not one. */
export function normalizeAddress(entry: string): string | null {
  let v = entry.trim();
  if (!v || v.length > 64) return null;
  // "[2001:db8::1]:443" or "[2001:db8::1]"
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(v);
  if (bracketed) v = bracketed[1]!;
  // "203.0.113.7:51234" (some load balancers append the port)
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(v)) v = v.slice(0, v.lastIndexOf(":"));
  v = v.toLowerCase();
  if (isIP(v) === 0) return null;
  // IPv4-mapped IPv6 is the same client as the plain IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  return mapped ? mapped[1]! : v;
}

export function clientIp(req: Request, hops = trustedProxyHops()): string {
  if (hops < 1) return UNKNOWN_ADDRESS;
  // Several X-Forwarded-For headers arrive joined with ", ", in order, which is what we want.
  const header = req.headers.get("x-forwarded-for");
  if (!header || header.length > 4096) return UNKNOWN_ADDRESS;
  const entries = header.split(",");
  if (entries.length < hops) return UNKNOWN_ADDRESS;
  return normalizeAddress(entries[entries.length - hops]!) ?? UNKNOWN_ADDRESS;
}
