import { describe, expect, it } from "vitest";
import { readJson } from "@/server/http";
import { AppError } from "@/server/errors";

/**
 * The JSON body reader never holds more than the limit in memory and does not trust
 * Content-Length. These tests drive it with hand-made streams (missing / false lengths, chunked,
 * slow, aborted); tests/integration/http-body.test.ts sends real HTTP to a production build.
 */
const LIMIT = 1_000_000;

function streamOf(chunks: Uint8Array[], opts: { delayMs?: number; failAfter?: number; onCancel?: () => void } = {}) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (opts.failAfter !== undefined && i >= opts.failAfter) return c.error(new Error("aborted"));
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (i >= chunks.length) return c.close();
      c.enqueue(chunks[i++]!);
    },
    cancel() {
      opts.onCancel?.();
    },
  });
}

function req(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    // @ts-expect-error Node needs this for stream bodies
    duplex: "half",
  });
}

async function failure(p: Promise<unknown>): Promise<{ status: number; code: string; raw: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return { status: e.status, code: e.code, raw: e.raw };
    throw e;
  }
  throw new Error("expected a failure");
}

const bytes = (n: number, fill = 32): Uint8Array<ArrayBuffer> => new Uint8Array(n).fill(fill);
/** A valid JSON document of exactly n bytes: {"a":"xxxx"} */
function jsonOf(n: number): Uint8Array<ArrayBuffer> {
  const s = `{"a":"${"x".repeat(n - 8)}"}`;
  expect(s.length).toBe(n);
  return new TextEncoder().encode(s);
}

describe("readJson", () => {
  it("accepts a body of exactly the limit and parses it", async () => {
    const body = jsonOf(LIMIT);
    const v = (await readJson(req(body, { "content-length": String(LIMIT) }))) as { a: string };
    expect(v.a.length).toBe(LIMIT - 8);
  });

  it("refuses limit + 1 bytes with 413", async () => {
    expect(await failure(readJson(req(jsonOf(LIMIT + 1))))).toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE", raw: "errors.bodyTooLarge" });
  });

  it("refuses a huge declared Content-Length before reading anything", async () => {
    let pulled = 0;
    const s = new ReadableStream<Uint8Array>({ pull: (c) => { pulled++; c.enqueue(bytes(65536)); } });
    expect(await failure(readJson(req(s, { "content-length": String(100 * 1024 * 1024) })))).toMatchObject({ status: 413 });
    expect(pulled).toBeLessThanOrEqual(1); // at most the stream's own first pre-fetch
  });

  it("cuts off a body with no Content-Length (chunked) as soon as it passes the limit", async () => {
    let cancelled = false;
    let produced = 0;
    const s = new ReadableStream<Uint8Array>({
      pull(c) {
        produced += 65536;
        c.enqueue(bytes(65536));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await failure(readJson(req(s)))).toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
    expect(produced).toBeLessThan(LIMIT + 3 * 65536); // stopped right after the limit, not at 100 MB
  });

  it("does not trust a Content-Length smaller than the real body", async () => {
    const s = streamOf(Array.from({ length: 40 }, () => bytes(65536)));
    expect(await failure(readJson(req(s, { "content-length": "10" })))).toMatchObject({ status: 413 });
  });

  it("refuses malformed, negative and contradictory Content-Length values with 400", async () => {
    for (const cl of ["abc", "-1", "1e3", "12, 13", "99999999999999999999", " "]) {
      expect(await failure(readJson(req(streamOf([jsonOf(10)]), { "content-length": cl }))), cl).toMatchObject({ status: 400, raw: "errors.badContentLength" });
    }
    // Repeated identical values are fine.
    expect(await readJson(req(streamOf([new TextEncoder().encode("{}")]), { "content-length": "2, 2" }))).toEqual({});
  });

  it("refuses a body shorter than its Content-Length (client stopped) with 400", async () => {
    expect(await failure(readJson(req(streamOf([jsonOf(10)]), { "content-length": "50" })))).toMatchObject({ status: 400, raw: "errors.bodyIncomplete" });
  });

  it("refuses an aborted upload with 400 and releases the stream", async () => {
    expect(await failure(readJson(req(streamOf([bytes(1000), bytes(1000)], { failAfter: 1 }))))).toMatchObject({ status: 400, raw: "errors.bodyIncomplete" });
  });

  it("refuses a body that arrives too slowly with 408 and cancels it", async () => {
    let cancelled = false;
    const s = streamOf(Array.from({ length: 100 }, () => bytes(10)), { delayMs: 50, onCancel: () => (cancelled = true) });
    const t = Date.now();
    expect(await failure(readJson(req(s), { timeoutMs: 300 }))).toMatchObject({ status: 408, code: "REQUEST_TIMEOUT", raw: "errors.bodyTimeout" });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(cancelled).toBe(true);
  });

  it("accepts a slow but timely body", async () => {
    const parts = ['{"a":', '"slow', ' but ', 'fine"}'].map((p) => new TextEncoder().encode(p));
    expect(await readJson(req(streamOf(parts, { delayMs: 20 })), { timeoutMs: 5000 })).toEqual({ a: "slow but fine" });
  });

  it("keeps the existing answers for invalid JSON, empty bodies, multi-byte text and wrong content type", async () => {
    expect(await failure(readJson(req("{not json")))).toMatchObject({ status: 422, raw: "errors.malformedJson" });
    expect(await readJson(req(null))).toEqual({});
    expect(await readJson(req(""))).toEqual({});
    // A multi-byte character split across chunks.
    const enc = new TextEncoder().encode('{"n":"مرحبا"}');
    expect(await readJson(req(streamOf([enc.slice(0, 7), enc.slice(7)])))).toEqual({ n: "مرحبا" });
    const plain = new Request("http://localhost/api/x", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(await failure(readJson(plain))).toMatchObject({ status: 422, raw: "errors.expectedJson" });
  });

  it("handles many concurrent oversized bodies without buffering them", async () => {
    const before = process.memoryUsage().arrayBuffers + process.memoryUsage().heapUsed;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => {
        // Each would be 100 MB if read to the end.
        let sent = 0;
        const s = new ReadableStream<Uint8Array>({
          pull(c) {
            if (sent >= 100 * 1024 * 1024) return c.close();
            sent += 1 << 20;
            c.enqueue(new Uint8Array(1 << 20));
          },
        });
        return failure(readJson(req(s)));
      }),
    );
    expect(results.every((r) => r.status === 413)).toBe(true);
    const grown = process.memoryUsage().arrayBuffers + process.memoryUsage().heapUsed - before;
    expect(grown).toBeLessThan(40 * 1024 * 1024); // well under 10 x 100 MB
  });
});
