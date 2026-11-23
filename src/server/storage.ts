import "server-only";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { BadRequestError, RateLimitError, RequestTimeoutError, ServiceUnavailableError } from "./errors";

/**
 * Uploaded files on the server's disk. UPLOAD_DIR must be outside the public folder: files are only
 * served through /api/attachments/[id], which checks the reader's permissions. Back this folder up
 * together with the database.
 */
export function uploadDir(): string {
  // Runtime data, not part of the build: tell the bundler not to trace the whole project from here.
  return path.resolve(/* turbopackIgnore: true */ process.env.UPLOAD_DIR || path.join(process.cwd(), "storage", "uploads"));
}

export const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 8) * 1024 * 1024;

/** Videos of the work (work evidence): larger than photos, so they have their own limit. */
export const MAX_VIDEO_BYTES = Math.max(1, Number(process.env.MAX_VIDEO_MB) || 50) * 1024 * 1024;

export type ImageType = "image/jpeg" | "image/png" | "image/webp";
export type VideoType = "video/mp4" | "video/quicktime" | "video/webm";

/** The real type of an image from its first bytes (the declared Content-Type is not trusted). */
export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

/**
 * The real type of a video from its first bytes: MP4 and QuickTime start with an "ftyp" box whose
 * brand tells them apart (phones record one or the other); WebM is an EBML document whose doctype
 * is "webm" (what desktop browsers record).
 */
export function detectVideoType(bytes: Uint8Array): VideoType | null {
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "qt  ") return "video/quicktime";
    if (/^(isom|iso[2-9]|mp4[12]|avc1|M4V |M4VP|dash|mmp4|MSNV)$/.test(brand)) return "video/mp4";
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    // The doctype ("webm"; Matroska files say "matroska" and are refused) sits in the EBML header.
    return ascii(bytes, 0, Math.min(bytes.length, 64)).includes("webm") ? "video/webm" : null;
  }
  return null;
}

const EXT: Record<ImageType | VideoType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };

function resolveKey(key: string): string {
  const root = uploadDir();
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error("Invalid storage key");
  return full;
}

/** Writes a new file and returns its storage key ("2026/10/<uuid>.jpg"). Never overwrites. */
export async function saveFile(bytes: Uint8Array, type: ImageType | VideoType, now = new Date()): Promise<string> {
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}.${EXT[type]}`;
  const full = resolveKey(key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, bytes, { flag: "wx" });
  return key;
}

export async function readStoredFile(key: string): Promise<Buffer> {
  return readFile(/* turbopackIgnore: true */ resolveKey(key));
}

/** The size of a stored file (for range requests). */
export async function storedFileSize(key: string): Promise<number> {
  return (await stat(/* turbopackIgnore: true */ resolveKey(key))).size;
}

/** Streams the bytes start..end (inclusive) of a stored file, so videos are not read into memory whole. */
export function streamStoredFile(key: string, start: number, end: number): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(/* turbopackIgnore: true */ resolveKey(key), { start, end })) as ReadableStream<Uint8Array>;
}

/**
 * The byte range a request asks for ("bytes=0-", "bytes=100-199", "bytes=-500"), within a file of
 * `size` bytes. null: the whole file (no or unusable Range header); "unsatisfiable": answer 416.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!suffix) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** Removes a file whose database row could not be written (never used for recorded files). */
export async function discardFile(key: string): Promise<void> {
  await rm(resolveKey(key), { force: true });
}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

// Bytes of upload bodies being received right now in this process (memory is per process).
const INFLIGHT_KEY = Symbol.for("ims.uploadBytesInFlight");
type InFlight = { bytes: number; perOwner: Map<string, { bytes: number; count: number }> };
const gUploads = globalThis as typeof globalThis & { [INFLIGHT_KEY]?: InFlight };
const inFlight = (): InFlight => (gUploads[INFLIGHT_KEY] ??= { bytes: 0, perOwner: new Map() });

export type ReadBodyOptions = {
  /**
   * Who is uploading (the signed-in user's id). Each owner may hold at most UPLOAD_MAX_INFLIGHT_PER_USER_MB
   * (default 64) and UPLOAD_MAX_CONCURRENT_PER_USER uploads (default 3) of the process budget at
   * once, so one account cannot take the whole budget; beyond that the request gets 429.
   */
  owner?: string;
  /** Longest time without any new bytes before the upload is refused (default UPLOAD_IDLE_TIMEOUT_MS, 30 s). */
  idleTimeoutMs?: number;
  /** Longest time for the whole body (default UPLOAD_TOTAL_TIMEOUT_MS, 15 min; Node itself ends a request after 5 min). */
  totalTimeoutMs?: number;
  /**
   * Slowest accepted average speed after `minRateGraceMs` (default UPLOAD_MIN_RATE_KBPS, 8 KiB/s, after
   * UPLOAD_MIN_RATE_GRACE_MS, 10 s). A trickled body cannot hold its reservation for minutes.
   */
  minBytesPerSecond?: number;
  minRateGraceMs?: number;
};

/**
 * Reads an upload body of at most `max` bytes into memory. Returns null when it is larger (the
 * caller answers "too large"); nothing beyond `max` is ever buffered.
 *
 * - Content-Length is checked first (larger is refused before reading; malformed or contradictory
 *   values get 400), but not trusted: the bytes are counted as they arrive.
 * - Memory budget: before reading, the body's size (the declared length, else `max`) is reserved
 *   from UPLOAD_MAX_INFLIGHT_MB (default 256) for this process; when that is used up by uploads in
 *   progress the request gets 503 at once instead of piling up in memory. Each owner (user) may
 *   hold only a share of it (see `owner`): 429 beyond that.
 * - A body that stops arriving (idle timeout), arrives slower than the minimum rate after the
 *   grace period, or takes too long overall gets 408; a body the client aborted gets 400
 *   (errors.bodyIncomplete), not a generic 500.
 * - Callers check the uploader's rights BEFORE calling this (`authorizeThenRead`), so a caller who
 *   may not upload never reserves anything.
 * - In every refusal the stream is cancelled and the reservation released.
 */
export async function readLimitedBody(req: Request, max: number, opts: ReadBodyOptions = {}): Promise<Uint8Array | null> {
  const raw = req.headers.get("content-length");
  let declared: number | null = null;
  if (raw !== null) {
    const values = new Set(raw.split(",").map((v) => v.trim()));
    const [v] = [...values] as [string];
    if (values.size !== 1 || !/^\d{1,15}$/.test(v)) {
      void req.body?.cancel().catch(() => undefined);
      throw new BadRequestError("errors.badContentLength");
    }
    declared = Number(v);
  }
  if (declared !== null && declared > max) {
    void req.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!req.body) return new Uint8Array();

  const budget = intFromEnv("UPLOAD_MAX_INFLIGHT_MB", 256, 1, 100_000) * 1024 * 1024;
  const perUserBytes = intFromEnv("UPLOAD_MAX_INFLIGHT_PER_USER_MB", 64, 1, 100_000) * 1024 * 1024;
  const perUserCount = intFromEnv("UPLOAD_MAX_CONCURRENT_PER_USER", 3, 1, 1000);
  const reserve = declared ?? max;
  const state = inFlight();
  const mine = opts.owner ? (state.perOwner.get(opts.owner) ?? { bytes: 0, count: 0 }) : null;
  // Checked and taken synchronously (no await in between), so concurrent requests cannot overshoot.
  if (mine && (mine.count >= perUserCount || mine.bytes + reserve > perUserBytes)) {
    void req.body.cancel().catch(() => undefined);
    throw new RateLimitError("errors.uploadBusy", 10);
  }
  if (state.bytes + reserve > budget) {
    void req.body.cancel().catch(() => undefined);
    throw new ServiceUnavailableError("errors.uploadBusy", 10);
  }
  state.bytes += reserve;
  if (mine && opts.owner) {
    mine.bytes += reserve;
    mine.count += 1;
    state.perOwner.set(opts.owner, mine);
  }
  const release = () => {
    state.bytes -= reserve;
    if (mine && opts.owner) {
      mine.bytes -= reserve;
      mine.count -= 1;
      if (mine.count <= 0) state.perOwner.delete(opts.owner);
    }
  };

  const idleMs = opts.idleTimeoutMs ?? intFromEnv("UPLOAD_IDLE_TIMEOUT_MS", 30_000, 1_000, 3_600_000);
  const totalMs = opts.totalTimeoutMs ?? intFromEnv("UPLOAD_TOTAL_TIMEOUT_MS", 15 * 60_000, 1_000, 6 * 3_600_000);
  const minRate = opts.minBytesPerSecond ?? intFromEnv("UPLOAD_MIN_RATE_KBPS", 8, 0, 1_000_000) * 1024;
  const graceMs = opts.minRateGraceMs ?? intFromEnv("UPLOAD_MIN_RATE_GRACE_MS", 10_000, 0, 600_000);
  const started = Date.now();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + totalMs;
  let timer: NodeJS.Timeout | undefined;
  try {
    for (;;) {
      // Wait no longer than: the idle limit, the overall deadline, and the moment the bytes so far
      // would fall below the minimum average rate (so a trickle is cut off as soon as it is too slow).
      const now = Date.now();
      const rateBound = minRate > 0 ? started + graceMs + (size * 1000) / minRate - now : Infinity;
      const wait = Math.min(idleMs, deadline - now, Math.max(rateBound, 1));
      if (deadline - now <= 0) throw new RequestTimeoutError();
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new RequestTimeoutError()), wait);
          }),
        ]);
      } catch (e) {
        if (e instanceof RequestTimeoutError) throw e;
        // The client went away or the connection broke mid-body.
        throw new BadRequestError("errors.bodyIncomplete");
      } finally {
        clearTimeout(timer);
      }
      if (step.done) break;
      size += step.value.byteLength;
      const elapsed = Date.now() - started;
      if (minRate > 0 && elapsed > graceMs && size < (minRate * (elapsed - graceMs)) / 1000) throw new RequestTimeoutError();
      if (size > max) {
        reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(step.value);
    }
  } catch (e) {
    reader.cancel().catch(() => undefined);
    throw e;
  } finally {
    release();
    reader.releaseLock();
  }
  if (declared !== null && size !== declared) throw new BadRequestError("errors.bodyIncomplete");
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Tests: bytes of upload bodies currently reserved in this process (in total, or by one owner). */
export function uploadBytesInFlight(owner?: string): number {
  const state = gUploads[INFLIGHT_KEY];
  if (!state) return 0;
  return owner ? (state.perOwner.get(owner)?.bytes ?? 0) : state.bytes;
}

/**
 * The upload routes' only way to read a body: first `authorize` (the caller's rights on the target,
 * checked without the file), and only then the bounded read, reserved for `owner`. When the check
 * refuses, the body is cancelled unread and nothing is reserved.
 */
export async function authorizeThenRead(req: Request, owner: string, max: number, authorize: () => Promise<unknown>): Promise<Uint8Array | null> {
  try {
    await authorize();
  } catch (e) {
    void req.body?.cancel().catch(() => undefined);
    throw e;
  }
  return readLimitedBody(req, max, { owner });
}
