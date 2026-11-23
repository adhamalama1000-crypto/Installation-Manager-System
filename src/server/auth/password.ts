import "server-only";
import { getHashPool, type JobOptions } from "./hash-pool";

/** bcrypt cost of new hashes. Existing hashes keep the cost stored in them (bcrypt reads it from the hash). */
const COST = 12;

/**
 * A fixed cost-12 bcrypt hash of a random throwaway string (no account uses it). Unknown accounts are
 * checked against it so they cost the same work and time as real ones and response time does not
 * reveal which emails exist. Constant, so the first unknown-account sign-in does not pay an extra hash.
 */
const DUMMY_HASH = "$2b$12$1d22sQzX5GaHay9ryGHgXugbmd7/pl1OXntqbi7kSjLQ/fkE9/QEi";

/**
 * Both functions run bcrypt on the worker-thread pool (src/server/auth/hash-pool.ts), never on the
 * main thread. They reject with HashPoolBusyError when the pool is full and HashPoolFailureError if a
 * worker fails; callers treat both as a temporary server problem.
 *
 * `job` picks the pool lane and names the client for the per-client limit (see hash-pool.ts);
 * without it a job is a standard one with no client.
 */
export function hashPassword(password: string, job?: JobOptions): Promise<string> {
  return getHashPool().hash(password, COST, job);
}

export async function verifyPassword(password: string, hash: string | null | undefined, job?: JobOptions): Promise<boolean> {
  if (!hash) {
    await getHashPool().compare(password, DUMMY_HASH, job);
    return false;
  }
  return getHashPool().compare(password, hash, job);
}
