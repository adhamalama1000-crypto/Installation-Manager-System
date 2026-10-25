import "server-only";
import bcrypt from "bcryptjs";

const COST = 12;

let dummyHash: Promise<string> | null = null;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) {
    // Spend the same time as a real check so response time does not reveal which emails exist.
    dummyHash ??= bcrypt.hash("not-a-real-password", COST);
    await bcrypt.compare(password, await dummyHash);
    return false;
  }
  return bcrypt.compare(password, hash);
}
