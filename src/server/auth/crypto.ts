import "server-only";
import { createHash, randomBytes } from "node:crypto";

/** Random bytes in a token from `randomToken()` (sessions, device tokens, password links). */
export const RANDOM_TOKEN_BYTES = 32;

export function randomToken(bytes = RANDOM_TOKEN_BYTES): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Whether `value` has exactly the shape `randomToken(bytes)` produces: unpadded base64url of `bytes`
 * bytes (43 characters for the default 32). Lets callers refuse forged values without a lookup.
 */
export function isRandomToken(value: string, bytes = RANDOM_TOKEN_BYTES): boolean {
  return value.length === Math.ceil((bytes * 4) / 3) && /^[A-Za-z0-9_-]+$/.test(value);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
