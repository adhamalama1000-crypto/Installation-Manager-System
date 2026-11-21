import { afterEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHashPool, HashPool, HashPoolBusyError, HashPoolFailureError, resetHashPoolForTests } from "@/server/auth/hash-pool";
import { hashPassword, verifyPassword } from "@/server/auth/password";

/** bcrypt on worker threads: correctness, limits, failure handling, and the main thread stays free. */

// A worker that behaves like the real one, except that it hangs or crashes on request.
const FAULTY = `
const { parentPort, workerData } = require("node:worker_threads");
const bcrypt = require(workerData.bcryptPath);
parentPort.on("message", (m) => {
  if (m.password === "hang") { for (;;) {} }
  if (m.password === "crash") process.exit(3);
  if (m.password === "throw") throw new Error("boom " + m.password);
  parentPort.postMessage({ id: m.id, ok: true, value: bcrypt.compareSync(m.password, m.hash) });
});
`;

const pools: HashPool[] = [];
function pool(opts: Partial<ConstructorParameters<typeof HashPool>[0]> = {}) {
  const p = new HashPool({ size: 2, maxQueue: 4, queueTimeoutMs: 5000, jobTimeoutMs: 10_000, ...opts });
  pools.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
  await resetHashPoolForTests();
});

const HASH12 = bcrypt.hashSync("Correct-Horse-1", 12);

describe("password verification on worker threads", () => {
  it("accepts the right password and refuses a wrong one", async () => {
    const p = pool();
    expect(await p.compare("Correct-Horse-1", HASH12)).toBe(true);
    expect(await p.compare("wrong", HASH12)).toBe(false);
    expect(p.stats()).toMatchObject({ completed: 2, crashes: 0 });
  });

  it("verifies existing hashes of every prefix and cost, and new hashes still use cost 12", async () => {
    for (const h of [bcrypt.hashSync("legacy-pass-1", 10), bcrypt.hashSync("legacy-pass-1", 4).replace("$2b$", "$2a$"), bcrypt.hashSync("legacy-pass-1", 12).replace("$2b$", "$2y$")]) {
      expect(await verifyPassword("legacy-pass-1", h), h.slice(0, 7)).toBe(true);
    }
    const fresh = await hashPassword("New-Password-77");
    expect(fresh).toMatch(/^\$2b\$12\$/);
    expect(bcrypt.compareSync("New-Password-77", fresh)).toBe(true); // readable by plain bcryptjs too
  });

  it("checks an unknown account against the dummy hash (same work) and refuses it", async () => {
    const t0 = performance.now();
    expect(await verifyPassword("anything", null)).toBe(false);
    const unknownMs = performance.now() - t0;
    const t1 = performance.now();
    await verifyPassword("anything", HASH12);
    const knownMs = performance.now() - t1;
    // Both are a full cost-12 bcrypt check; generous bounds for a shared CI machine.
    expect(unknownMs).toBeGreaterThan(knownMs * 0.5);
    expect(unknownMs).toBeLessThan(knownMs * 2 + 50);
    expect(getHashPool().stats().completed).toBe(2);
  });

  it("treats a malformed stored hash as a failed check, not a crash", async () => {
    const p = pool();
    expect(await p.compare("x", "not-a-bcrypt-hash")).toBe(false);
    expect(p.stats().crashes).toBe(0);
  });

  it("runs as many checks at once as it has workers, and queues the rest", async () => {
    const p = pool({ size: 2, maxQueue: 10 });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => p.compare(i % 2 ? "wrong" : "Correct-Horse-1", HASH12)));
    expect(results).toEqual([true, false, true, false, true, false]);
    expect(p.stats()).toMatchObject({ workers: 2, busy: 0, queued: 0, completed: 6 });
  });

  it("refuses at once when workers and queue are full (bounded memory)", async () => {
    const p = pool({ size: 1, maxQueue: 2 });
    const accepted = [p.compare("a", HASH12), p.compare("b", HASH12), p.compare("c", HASH12)];
    expect(p.hasCapacity()).toBe(false);
    const t = performance.now();
    await expect(p.compare("d", HASH12)).rejects.toBeInstanceOf(HashPoolBusyError);
    expect(performance.now() - t).toBeLessThan(50);
    expect(p.stats()).toMatchObject({ busy: 1, queued: 2, rejectedBusy: 1 });
    expect(await Promise.all(accepted)).toEqual([false, false, false]);
    expect(p.hasCapacity()).toBe(true);
  });

  it("gives up on a job that waited too long in the queue", async () => {
    const p = pool({ size: 1, maxQueue: 5, queueTimeoutMs: 200 });
    const first = p.compare("a", HASH12);
    const waiting = [p.compare("b", HASH12), p.compare("c", HASH12)];
    const settled = await Promise.allSettled(waiting);
    // A cost-12 check takes far longer than 200 ms, so the second one cannot start in time.
    expect(settled.some((s) => s.status === "rejected" && s.reason instanceof HashPoolBusyError)).toBe(true);
    expect(p.stats().queueTimeouts).toBeGreaterThanOrEqual(1);
    expect(await first).toBe(false);
  });

  it("terminates and replaces a worker that hangs", async () => {
    const p = pool({ size: 1, maxQueue: 5, jobTimeoutMs: 1000, source: FAULTY });
    await expect(p.compare("hang", HASH12)).rejects.toBeInstanceOf(HashPoolFailureError);
    expect(p.stats().jobTimeouts).toBe(1);
    // The replacement serves the next job.
    expect(await p.compare("Correct-Horse-1", HASH12)).toBe(true);
    expect(p.stats().workers).toBe(1);
  });

  it("fails the job of a worker that crashes and replaces the worker", async () => {
    const p = pool({ size: 1, maxQueue: 5, source: FAULTY });
    const queued = p.compare("Correct-Horse-1", HASH12);
    await expect(Promise.race([p.compare("crash", HASH12), queued.then(() => "first done")])).resolves.toBe("first done");
    const crashing = p.compare("crash", HASH12);
    const after = p.compare("Correct-Horse-1", HASH12); // queued behind the crash
    await expect(crashing).rejects.toBeInstanceOf(HashPoolFailureError);
    expect(await after).toBe(true);
    await expect(p.compare("throw", HASH12)).rejects.toBeInstanceOf(HashPoolFailureError);
    expect(await p.compare("Correct-Horse-1", HASH12)).toBe(true);
    expect(p.stats().crashes).toBeGreaterThanOrEqual(2);
    expect(p.stats().workers).toBe(1);
  });

  it("never puts the password into an error", async () => {
    const p = pool({ size: 1, source: FAULTY });
    const e = await p.compare("throw", HASH12).catch((x: Error) => x);
    expect(String(e)).not.toContain("throw");
    expect((e as Error).message).not.toContain(HASH12);
  });

  it("shuts down: queued and running jobs fail, new jobs are refused", async () => {
    const p = pool({ size: 1, maxQueue: 3 });
    const jobs = [p.compare("a", HASH12), p.compare("b", HASH12)].map((j) => j.catch((e: Error) => e));
    await p.close();
    for (const e of await Promise.all(jobs)) expect(e).toBeInstanceOf(HashPoolBusyError);
    await expect(p.compare("a", HASH12)).rejects.toBeInstanceOf(HashPoolBusyError);
    expect(p.stats()).toMatchObject({ workers: 0, queued: 0 });
  });

  it("keeps the main thread responsive while checking passwords (measured)", async () => {
    const p = pool({ size: 2, maxQueue: 20 });
    await p.compare("warm", HASH12);
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();
    const t = performance.now();
    await Promise.all(Array.from({ length: 8 }, () => p.compare("wrong", HASH12)));
    const elapsed = performance.now() - t;
    h.disable();
    const maxMs = h.max / 1e6;
    // Eight cost-12 checks are ~2.5 s of CPU; on the main thread the loop would stall ~300 ms per check.
    console.log(`[hash-pool] 8 checks in ${elapsed.toFixed(0)} ms, event-loop delay max ${maxMs.toFixed(1)} ms, p99 ${(h.percentile(99) / 1e6).toFixed(1)} ms`);
    expect(maxMs).toBeLessThan(100);

    // For comparison, one check on the main thread blocks the loop for its whole duration.
    const t2 = performance.now();
    bcrypt.compareSync("wrong", HASH12);
    const blockedMs = performance.now() - t2;
    console.log(`[hash-pool] one compareSync on the main thread blocked it for ${blockedMs.toFixed(0)} ms`);
    expect(blockedMs).toBeGreaterThan(maxMs);
  });

  describe("lanes and per-client limits", () => {
    it("keeps the reserved places for priority jobs: standard ones are refused first", async () => {
      // 1 worker + 3 queued = 4 places, 2 of them reserved for priority.
      const p = pool({ size: 1, maxQueue: 3, priorityReserve: 2 });
      const standard = [p.compare("a", HASH12), p.compare("b", HASH12)];
      expect(p.hasCapacity()).toBe(false);
      await expect(p.compare("c", HASH12)).rejects.toBeInstanceOf(HashPoolBusyError);
      expect(p.hasCapacity({ lane: "priority" })).toBe(true);
      const priority = [p.compare("Correct-Horse-1", HASH12, { lane: "priority" }), p.compare("d", HASH12, { lane: "priority" })];
      // Now the pool is full for everyone.
      await expect(p.compare("e", HASH12, { lane: "priority" })).rejects.toBeInstanceOf(HashPoolBusyError);
      expect(p.stats()).toMatchObject({ inFlightStandard: 2, inFlightPriority: 2, rejectedLane: 1, rejectedBusy: 1 });
      expect(await Promise.all([...standard, ...priority])).toEqual([false, false, true, false]);
      expect(p.stats()).toMatchObject({ inFlightStandard: 0, inFlightPriority: 0 });
    });

    it("starts waiting priority jobs before waiting standard ones", async () => {
      const p = pool({ size: 1, maxQueue: 10 });
      const order: string[] = [];
      const track = (name: string, job: Promise<boolean>) => job.then(() => order.push(name));
      const jobs = [
        track("s1", p.compare("a", HASH12)), // runs at once
        track("s2", p.compare("b", HASH12)),
        track("s3", p.compare("c", HASH12)),
        track("p1", p.compare("d", HASH12, { lane: "priority" })),
      ];
      await Promise.all(jobs);
      expect(order).toEqual(["s1", "p1", "s2", "s3"]);
    });

    it("lets one client hold at most maxPerClient places, per lane", async () => {
      const p = pool({ size: 2, maxQueue: 10, maxPerClient: 2 });
      const mine = [p.compare("a", HASH12, { client: "ip:1" }), p.compare("b", HASH12, { client: "ip:1" })];
      expect(p.hasCapacity({ client: "ip:1" })).toBe(false);
      await expect(p.compare("c", HASH12, { client: "ip:1" })).rejects.toBeInstanceOf(HashPoolBusyError);
      expect(p.hasCapacity({ client: "ip:2" })).toBe(true);
      expect(p.hasCapacity({})).toBe(true); // an unidentified client is not limited per client
      const other = p.compare("Correct-Horse-1", HASH12, { client: "ip:2" });
      expect(p.stats().rejectedClient).toBe(1);
      expect(await Promise.all([...mine, other])).toEqual([false, false, true]);
      // Places are given back when jobs finish (or fail).
      expect(p.hasCapacity({ client: "ip:1" })).toBe(true);
    });

    it("gives places back on every outcome: success, worker failure, queue timeout", async () => {
      const p = pool({ size: 1, maxQueue: 2, maxPerClient: 1, queueTimeoutMs: 200, source: FAULTY });
      await expect(p.compare("throw", HASH12, { client: "c1" })).rejects.toBeInstanceOf(HashPoolFailureError);
      expect(p.hasCapacity({ client: "c1" })).toBe(true);
      const first = p.compare("x", HASH12, { client: "a" });
      await expect(p.compare("y", HASH12, { client: "b" })).rejects.toBeInstanceOf(HashPoolBusyError); // waited > 200 ms
      expect(p.hasCapacity({ client: "b" })).toBe(true);
      await first;
      expect(p.stats()).toMatchObject({ inFlightStandard: 0, queued: 0 });
    });

    it("does not respawn crashing workers on every new job while backing off", async () => {
      const p = pool({ size: 1, maxQueue: 50, queueTimeoutMs: 300, source: FAULTY });
      for (let i = 0; i < 4; i++) await expect(p.compare("crash", HASH12)).rejects.toBeInstanceOf(HashPoolFailureError);
      // The 4th crash in a minute starts a back-off: no worker for ~1 s, whatever arrives meanwhile.
      const waiting = Array.from({ length: 10 }, () => p.compare("x", HASH12).catch((e: Error) => e));
      expect(p.stats().workers).toBe(0);
      for (const e of await Promise.all(waiting)) expect(e).toBeInstanceOf(HashPoolBusyError);
      expect(p.stats().crashes).toBe(4);
    });
  });
});
