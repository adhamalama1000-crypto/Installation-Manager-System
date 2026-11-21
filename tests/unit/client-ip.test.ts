import { afterEach, describe, expect, it } from "vitest";
import { clientIp, normalizeAddress, trustedProxyHops } from "@/server/auth/client-ip";

/** X-Forwarded-For is only believed as far as the operator says proxies are trusted. */
const r = (headers: Record<string, string>) => new Request("http://localhost/api/auth/login", { headers });

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
});

describe("client address", () => {
  it("ignores every forwarding header by default (no trusted proxy)", () => {
    expect(trustedProxyHops()).toBe(0);
    expect(clientIp(r({ "x-forwarded-for": "203.0.113.7" }))).toBe("unknown");
    expect(clientIp(r({ "x-real-ip": "203.0.113.7" }))).toBe("unknown");
    expect(clientIp(r({}))).toBe("unknown");
  });

  it("with one trusted proxy takes the entry that proxy appended (the rightmost), never the client's", () => {
    // The client sent "1.1.1.1, 2.2.2.2"; the proxy appended the real peer 198.51.100.4.
    expect(clientIp(r({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 198.51.100.4" }), 1)).toBe("198.51.100.4");
    expect(clientIp(r({ "x-forwarded-for": "198.51.100.4" }), 1)).toBe("198.51.100.4");
    // X-Real-IP is never used.
    expect(clientIp(r({ "x-real-ip": "9.9.9.9" }), 1)).toBe("unknown");
  });

  it("with two proxies takes the second entry from the right", () => {
    expect(clientIp(r({ "x-forwarded-for": "6.6.6.6, 198.51.100.4, 10.0.0.2" }), 2)).toBe("198.51.100.4");
    // Fewer entries than proxies: the request did not pass through all of them.
    expect(clientIp(r({ "x-forwarded-for": "198.51.100.4" }), 2)).toBe("unknown");
  });

  it("joins repeated headers in order", () => {
    const h = new Headers();
    h.append("x-forwarded-for", "6.6.6.6");
    h.append("x-forwarded-for", "198.51.100.4");
    expect(clientIp(new Request("http://localhost/", { headers: h }), 1)).toBe("198.51.100.4");
  });

  it("refuses malformed entries instead of guessing", () => {
    for (const bad of ["", " , ", "not-an-ip", "1.2.3", "999.1.1.1", "1.2.3.4 5.6.7.8", "<script>", "a".repeat(80)]) {
      expect(clientIp(r({ "x-forwarded-for": bad }), 1), bad).toBe("unknown");
    }
    expect(clientIp(r({ "x-forwarded-for": "1.1.1.1,".repeat(2000) }), 1)).toBe("unknown"); // oversized header
  });

  it("normalises ports, brackets, case and IPv4-mapped IPv6", () => {
    expect(normalizeAddress("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(normalizeAddress("[2001:DB8::1]:443")).toBe("2001:db8::1");
    expect(normalizeAddress("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeAddress("2001:db8::1")).toBe("2001:db8::1");
  });

  it("reads TRUSTED_PROXY_HOPS safely", () => {
    for (const [v, n] of [["1", 1], ["2", 2], ["0", 0], ["-1", 0], ["abc", 0], ["1.5", 0], ["11", 0], [" ", 0]] as const) {
      process.env.TRUSTED_PROXY_HOPS = v;
      expect(trustedProxyHops(), v).toBe(n);
    }
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(clientIp(r({ "x-forwarded-for": "6.6.6.6, 198.51.100.4" }))).toBe("198.51.100.4");
  });
});
