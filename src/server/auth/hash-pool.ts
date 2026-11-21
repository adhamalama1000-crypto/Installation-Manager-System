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
 * - Two lanes: a share of the places (AUTH_HASH_PRIORITY_RESERVE) is kept for "priority" jobs
 *   (sign-ins from known devices, signed-in users), which also start before waiting standard ones.
 *   A flood of unknown sign-ins can fill only the standard share.
 * - Per-client limit (AUTH_HASH_MAX_PER_CLIENT): one client can never hold more than a few places.
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
  /**
   * Places (running + queued, out of size + maxQueue) that only priority jobs may take: standard
   * jobs are refused once the pool is that close to full. Default 0 (no lanes) for direct use.
   */
  priorityReserve?: number;
  /** Most jobs one client may have running or queued at once (per lane, per process). 0 = no limit. */
  maxPerClient?: number;
  /** Worker code (tests replace it to simulate crashes and hangs). */
  source?: string;
  /** Absolute path of bcryptjs, passed to the workers. */
  bcryptPath?: string;
};

/**
 * Who a job is for. "priority": sign-ins from a known device and signed-in users (password change);
 * "standard": everything else (sign-ins from unknown devices). `client` identifies the requester
 * (a trusted address, a device, a user) for the per-client limit; omit it when unknown.
 */
export type JobOptions = { lane?: "priority" | "standard"; client?: string };

export type HashPoolStats = {
  size: number;
  workers: number;
  busy: number;
  queued: number;
  queuedPriority: number;
  inFlightStandard: number;
  inFlightPriority: number;
  completed: number;
  rejectedBusy: number;
  rejectedLane: number;
  rejectedClient: number;
  queueTimeouts: number;
  jobTimeouts: number;
  crashes: number;
};

type Lane = "priority" | "standard";
type Op = { op: "compare"; password: string; hash: string } | { op: "hash"; password: string; cost: number };
type Job = { id: number; msg: Op; lane: Lane; client?: string; resolve: (v: unknown) => void; reject: (e: Error) => void; queueTimer?: NodeJS.Timeout; settled?: boolean };
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
  /** Waiting jobs per lane; priority ones always start first. */
  private readonly queues: Record<Lane, Job[]> = { priority: [], standard: [] };
  /** Running + queued jobs per lane and per (lane, client). */
  private readonly inFlight: Record<Lane, number> = { priority: 0, standard: 0 };
  private readonly perClient = new Map<string, number>();
  private nextId = 1;
  private closed = false;
  private crashTimes: number[] = [];
  private respawnDelay = 0;
  private respawnPending = false;
  private readonly counters = { completed: 0, rejectedBusy: 0, rejectedLane: 0, rejectedClient: 0, queueTimeouts: 0, jobTimeouts: 0, crashes: 0 };

  constructor(opts: HashPoolOptions) {
    this.opts = { source: WORKER_SOURCE, bcryptPath: opts.bcryptPath ?? resolveBcrypt(), priorityReserve: 0, maxPerClient: 0, ...opts } as Required<HashPoolOptions>;
    if (!Number.isInteger(this.opts.size) || this.opts.size < 1) throw new Error("hash pool size must be >= 1");
    const capacity = this.opts.size + this.opts.maxQueue;
    // Standard jobs always keep at least one place, priority ones always have the whole pool.
    this.opts.priorityReserve = Math.max(0, Math.min(this.opts.priorityReserve, capacity - 1));
  }

  compare(password: string, hash: string, job: JobOptions = {}): Promise<boolean> {
    return this.submit({ op: "compare", password, hash }, job) as Promise<boolean>;
  }

  hash(password: string, cost: number, job: JobOptions = {}): Promise<string> {
    return this.submit({ op: "hash", password, cost }, job) as Promise<string>;
  }

  /** Whether a job submitted now for this lane and client would be accepted. */
  hasCapacity(job: JobOptions = {}): boolean {
    return this.refusal(job.lane ?? "standard", job.client) === null;
  }

  stats(): HashPoolStats {
    return {
      size: this.opts.size,
      workers: this.slots.length,
      busy: this.slots.filter((s) => s.job).length,
      queued: this.queues.priority.length + this.queues.standard.length,
      queuedPriority: this.queues.priority.length,
      inFlightStandard: this.inFlight.standard,
      inFlightPriority: this.inFlight.priority,
      ...this.counters,
    };
  }

  /** Stops the workers; queued and running jobs fail with HashPoolBusyError. */
  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queues.priority.splice(0), ...this.queues.standard.splice(0)]) {
      clearTimeout(job.queueTimer);
      this.finish(job, new HashPoolBusyError());
    }
    const slots = this.slots.splice(0);
    await Promise.all(
      slots.map(async (s) => {
        s.retired = true;
        clearTimeout(s.jobTimer);
        if (s.job) this.finish(s.job, new HashPoolBusyError());
        s.job = null;
        await s.worker.terminate().catch(() => undefined);
      }),
    );
  }

  /** Why a new job of this lane/client would be refused, or null. */
  private refusal(lane: Lane, client: string | undefined): "closed" | "full" | "lane" | "client" | null {
    if (this.closed) return "closed";
    const capacity = this.opts.size + this.opts.maxQueue;
    const total = this.inFlight.priority + this.inFlight.standard;
    if (total >= capacity) return "full";
    if (lane === "standard" && this.inFlight.standard >= capacity - this.opts.priorityReserve) return "lane";
    if (client && this.opts.maxPerClient > 0 && (this.perClient.get(`${lane}:${client}`) ?? 0) >= this.opts.maxPerClient) return "client";
    return null;
  }

  private submit(msg: Op, opts: JobOptions): Promise<unknown> {
    const lane: Lane = opts.lane ?? "standard";
    const client = opts.client;
    const why = this.refusal(lane, client);
    if (why) {
      if (why === "lane") this.counters.rejectedLane++;
      else if (why === "client") this.counters.rejectedClient++;
      else if (why === "full") this.counters.rejectedBusy++;
      return Promise.reject(new HashPoolBusyError());
    }
    this.ensureWorkers();
    return new Promise((resolve, reject) => {
      const job: Job = { id: this.nextId++, msg, lane, client, resolve, reject };
      this.inFlight[lane]++;
      if (client) this.perClient.set(`${lane}:${client}`, (this.perClient.get(`${lane}:${client}`) ?? 0) + 1);
      const slot = this.slots.find((s) => !s.job && !s.retired);
      if (slot) return this.run(slot, job);
      job.queueTimer = setTimeout(() => {
        const q = this.queues[lane];
        const i = q.indexOf(job);
        if (i >= 0) {
          q.splice(i, 1);
          this.counters.queueTimeouts++;
          this.finish(job, new HashPoolBusyError());
        }
      }, this.opts.queueTimeoutMs);
      job.queueTimer.unref();
      this.queues[lane].push(job);
    });
  }

  /** Settles a job exactly once and gives back its places. */
  private finish(job: Job, error: Error | null, value?: unknown) {
    if (job.settled) return;
    job.settled = true;
    this.inFlight[job.lane]--;
    if (job.client) {
      const k = `${job.lane}:${job.client}`;
      const n = (this.perClient.get(k) ?? 1) - 1;
      if (n > 0) this.perClient.set(k, n);
      else this.perClient.delete(k);
    }
    if (error) job.reject(error);
    else job.resolve(value);
  }

  private ensureWorkers() {
    // While a crash back-off is pending, do not respawn on every request (that is what the back-off
    // is for); the timer restarts the workers.
    if (this.respawnPending) return;
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
      if (reply.ok) this.finish(job, null, reply.value);
      else this.finish(job, new HashPoolFailureError(reply.error ?? "error"));
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
    const next = this.queues.priority.shift() ?? this.queues.standard.shift();
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
      this.finish(job, new HashPoolFailureError(reason));
    }
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    if (this.closed) return;
    // A hung job is a timeout, not a crash: it does not count toward the crash back-off.
    if (reason === "timed out") return this.restartWorkers(0);
    this.counters.crashes++;
    // Back off when workers keep dying (e.g. a broken installation): 0, 0, 0, then 1 s doubling to 30 s.
    const now = Date.now();
    this.crashTimes = [...this.crashTimes.filter((t) => now - t < 60_000), now];
    this.respawnDelay = this.crashTimes.length > 3 ? Math.min(30_000, Math.max(1_000, this.respawnDelay * 2)) : 0;
    this.restartWorkers(this.respawnDelay);
  }

  private restartWorkers(delay: number) {
    const restart = () => {
      this.respawnPending = false;
      if (this.closed) return;
      this.ensureWorkers();
      for (const s of this.slots) this.drain(s);
    };
    if (!delay) return restart();
    this.respawnPending = true;
    setTimeout(restart, delay).unref();
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
  const maxQueue = intFromEnv("AUTH_HASH_MAX_QUEUE", size * 12, 0, 10_000);
  return {
    size,
    maxQueue,
    queueTimeoutMs: intFromEnv("AUTH_HASH_QUEUE_TIMEOUT_MS", 5_000, 100, 120_000),
    jobTimeoutMs: intFromEnv("AUTH_HASH_JOB_TIMEOUT_MS", 10_000, 1_000, 120_000),
    // A third of the places (at least one per worker) stay free for known devices and signed-in
    // users, so a flood of unknown sign-ins cannot take the whole pool.
    priorityReserve: intFromEnv("AUTH_HASH_PRIORITY_RESERVE", Math.max(size, Math.ceil((size + maxQueue) / 3)), 0, 10_000),
    // One client (a trusted address, a device, a user) may have at most this many checks at once.
    maxPerClient: intFromEnv("AUTH_HASH_MAX_PER_CLIENT", 2, 0, 10_000),
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
