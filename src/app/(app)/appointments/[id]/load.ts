import { notFound } from "next/navigation";
import { NotFoundError } from "@/server/errors";

/** Turns a service NotFoundError (including "not visible to you") into the 404 page. */
export async function loadOr404<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
}
