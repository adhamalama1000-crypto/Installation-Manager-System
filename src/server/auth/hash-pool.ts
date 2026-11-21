import "server-only";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

/**
 * A small, fixed pool of worker threads for bcrypt. A bcrypt check costs ~300 ms of CPU; run on the
 * main thread it stalls every other request (a handful of failed sign-ins froze the server for
 * seconds). Here the main thread only passes messages.
 *
 * - Fixed size (AUTH_HASH_THREADS), workers are created once and reused, never per request.
 * - Bounded queue (AUTH_HASH_MAX_QUEUE) with a wait limit (AUTH_HASH_QUEUE_TIMEOUT_MS): when the
 *   pool is full a job is refused at once with HashPoolBusyError instead of piling up.
 * - Per-job limit (AUTH_HASH_JOB_TIMEOUT_MS): a stuck worker is terminated and replaced.
 * - A crashed worker is replaced; repeated crashes back off so a broken setup cannot spin.
 * - Passwords and hashes only travel in messages; nothing here logs them.
 */

export class HashPoolBusyError extends Error {
  constructor() {
    super("password hashing pool is busy");
    this.name = "HashPoolBusyError";
  }
}

export class HashPoolFailureError extends Error {
  constructor(reason: string) {
    super(`password hashing failed: ${reason}`);
    this.name = "HashPoolFailureError";
  }
}

export type HashPoolOptions = {
  size: number;
  maxQueue: number;
  queueTimeoutMs: number;
  jobTimeoutMs: number;
  /** Worker code (tests replace it to simulate crashes and hangs). */
  source?: string;
  /** Absolute path of bcryptjs, passed to the workers. */
  bcryptPath?: string;
};

export type HashPoolStats = {
  size: number;
  workers: number;
  busy: number;
  queued: number;
  completed: number;
  rejectedBusy: number;
  queueTimeouts: number;
  jobTimeouts: number;
  crashes: number;
};

type Op = { op: "compare"; password: string; hash: string } | { op: "hash"; password: string; cost: number };
type Job = { id: number; msg: Op; resolve: (v: unknown) => void; reject: (e: Error) => void; queueTimer?: NodeJS.Timeout };
type Slot = { worker: Worker; job: Job | null; jobTimer?: NodeJS.Timeout; retired: boolean };

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const bcrypt = require(workerData.bcryptPath);
parentPort.on("message", (m) => {
  let reply;
  try {
    if (m.op === "compare") reply = { id: m.id, ok: true, value: bcrypt.compareSync(m.password, m.hash) };
    else if (m.op === "hash") reply = { id: m.id, ok: true, value: bcrypt.hashSync(m.password, m.cost) };
    else reply = { id: m.id, ok: false, error: "unknown operation" };
  } catch (e) {
    // Only the error's name: messages could echo input.
    reply = { id: m.id, ok: false, error: (e && e.name) || "Error" };
  }
  parentPort.postMessage(reply);
});
`;

function resolveBcrypt(): string {
  // bcryptjs is a server-external package (not bundled), so it is on disk in node_modules; workers
  // load it with plain require. Looked up from the app folder, then from this module's location.
  for (const from of [path.join(process.cwd(), "package.json"), import.meta.url]) {
    try {
      return createRequire(from).resolve("bcryptjs");
    } catch {
      // try the next location
    }
  }
  throw new Error("bcryptjs could not be found for the password hashing workers");
}

export class HashPool {
  private readonly opts: Required<HashPoolOptions>;
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private nextId = 1;
  private closed = false;
  private crashTimes: number[] = [];
  private respawnDelay = 0;
  private readonly counters = { completed: 0, rejectedBusy: 0, queueTimeouts: 0, jobTimeouts: 0, crashes: 0 };

  constructor(opts: HashPoolOptions) {
    this.opts = { source: WORKER_SOURCE, bcryptPath: opts.bcryptPath ?? resolveBcrypt(), ...opts } as Required<HashPoolOptions>;
    if (!Number.isInteger(this.opts.size) || this.opts.size < 1) throw new Error("hash pool size must be >= 1");
  }

  compare(password: string, hash: string): Promise<boolean> {
    return this.submit({ op: "compare", password, hash }) as Promise<boolean>;
  }

  hash(password: string, cost: number): Promise<string> {
    return this.submit({ op: "hash", password, cost }) as Promise<string>;
  }

  /** Whether a job submitted now would be accepted (an idle worker or room in the queue). */
  hasCapacity(): boolean {
    if (this.closed) return false;
    const idle = this.slots.length < this.opts.size || this.slots.some((s) => !s.job && !s.retired);
    return idle || this.queue.length < this.opts.maxQueue;
  }

  stats(): HashPoolStats {
    return {
      size: this.opts.size,
      workers: this.slots.length,
      busy: this.slots.filter((s) => s.job).length,
      queued: this.queue.length,
      ...this.counters,
    };
  }

  /** Stops the workers; queued and running jobs fail with HashPoolBusyError. */
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.queueTimer);
      job.reject(new HashPoolBusyError());
    }
    const slots = this.slots.splice(0);
    await Promise.all(
      slots.map(async (s) => {
        s.retired = true;
        clearTimeout(s.jobTimer);
        if (s.job) s.job.reject(new HashPoolBusyError());
        s.job = null;
        await s.worker.terminate().catch(() => undefined);
      }),
    );
  }

  private submit(msg: Op): Promise<unknown> {
    if (this.closed) return Promise.reject(new HashPoolBusyError());
    this.ensureWorkers();
    return new Promise((resolve, reject) => {
      const job: Job = { id: this.nextId++, msg, resolve, reject };
      const slot = this.slots.find((s) => !s.job && !s.retired);
      if (slot) return this.run(slot, job);
      if (this.queue.length >= this.opts.maxQueue) {
        this.counters.rejectedBusy++;
        return reject(new HashPoolBusyError());
      }
      job.queueTimer = setTimeout(() => {
        const i = this.queue.indexOf(job);
        if (i >= 0) {
          this.queue.splice(i, 1);
          this.counters.queueTimeouts++;
          reject(new HashPoolBusyError());
        }
      }, this.opts.queueTimeoutMs);
      job.queueTimer.unref();
      this.queue.push(job);
    });
  }

  private ensureWorkers() {
    while (!this.closed && this.slots.length < this.opts.size) this.spawn();
  }

  private spawn() {
    const worker = new Worker(this.opts.source, { eval: true, workerData: { bcryptPath: this.opts.bcryptPath } });
    // Idle workers must not keep the process alive (shutdown, tests).
    worker.unref();
    const slot: Slot = { worker, job: null, retired: false };
    worker.on("message", (reply: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const job = slot.job;
      if (!job || job.id !== reply.id) return;
      clearTimeout(slot.jobTimer);
      slot.job = null;
      this.counters.completed++;
      this.respawnDelay = 0;
      if (reply.ok) job.resolve(reply.value);
      else job.reject(new HashPoolFailureError(reply.error ?? "error"));
      this.drain(slot);
    });
    worker.on("error", () => this.lost(slot, "worker error"));
    worker.on("exit", () => this.lost(slot, "worker exited"));
    this.slots.push(slot);
  }

  private run(slot: Slot, job: Job) {
    slot.job = job;
    clearTimeout(job.queueTimer);
    slot.jobTimer = setTimeout(() => {
      if (slot.job !== job) return;
      this.counters.jobTimeouts++;
      // Fail the job now; the worker is stuck, so it is replaced.
      this.lost(slot, "timed out");
      void slot.worker.terminate().catch(() => undefined);
    }, this.opts.jobTimeoutMs);
    slot.jobTimer.unref();
    slot.worker.postMessage({ id: job.id, ...job.msg });
  }

  private drain(slot: Slot) {
    if (slot.retired || slot.job) return;
    const next = this.queue.shift();
    if (next) this.run(slot, next);
  }

  /** A worker died, errored or hung: fail its job, drop it and start a replacement. */
  private lost(slot: Slot, reason: string) {
    if (slot.retired) return;
    slot.retired = true;
    clearTimeout(slot.jobTimer);
    if (slot.job) {
      const job = slot.job;
      slot.job = null;
      job.reject(new HashPoolFailureError(reason));
    }
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    if (this.closed) return;
    if (reason !== "timed out") this.counters.crashes++;
    // Back off when workers keep dying (e.g. a broken installation): 0, 0, 0, then 1 s doubling to 30 s.
    const now = Date.now();
    this.crashTimes = [...this.crashTimes.filter((t) => now - t < 60_000), now];
    this.respawnDelay = this.crashTimes.length > 3 ? Math.min(30_000, Math.max(1_000, this.respawnDelay * 2)) : 0;
    const restart = () => {
      if (this.closed) return;
      this.ensureWorkers();
      for (const s of this.slots) this.drain(s);
    };
    if (this.respawnDelay) setTimeout(restart, this.respawnDelay).unref();
    else restart();
  }
}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Pool settings from the environment, with safe defaults for small servers. */
export function hashPoolOptionsFromEnv(): HashPoolOptions {
  // Leave at least one core for the main thread; never more than 2 by default (a 4-core server
  // then checks ~6 passwords per second while still serving everything else).
  const size = intFromEnv("AUTH_HASH_THREADS", Math.min(2, Math.max(1, availableParallelism() - 1)), 1, 16);
  return {
    size,
    maxQueue: intFromEnv("AUTH_HASH_MAX_QUEUE", size * 12, 0, 10_000),
    queueTimeoutMs: intFromEnv("AUTH_HASH_QUEUE_TIMEOUT_MS", 5_000, 100, 120_000),
    jobTimeoutMs: intFromEnv("AUTH_HASH_JOB_TIMEOUT_MS", 10_000, 1_000, 120_000),
  };
}

// One pool per process, shared by every server bundle (pages and route handlers load their own
// copies of this module in a production build).
const POOL_KEY = Symbol.for("ims.authHashPool");
type GlobalWithPool = typeof globalThis & { [POOL_KEY]?: HashPool };

export function getHashPool(): HashPool {
  const g = globalThis as GlobalWithPool;
  g[POOL_KEY] ??= new HashPool(hashPoolOptionsFromEnv());
  return g[POOL_KEY];
}

/** Tests: stop and forget the shared pool. */
export async function resetHashPoolForTests(): Promise<void> {
  const g = globalThis as GlobalWithPool;
  const pool = g[POOL_KEY];
  g[POOL_KEY] = undefined;
  await pool?.close();
}
