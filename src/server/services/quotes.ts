import "server-only";
import { msg } from "@/i18n/translator";
import { parseQuote, quoteForReader } from "@/lib/quote";
import type { QuoteDTO } from "@/lib/types";
import { prisma } from "../db";
import { appointmentScope, assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { canManageAppointment } from "./appointments";
import { canSeePrices } from "./payments";

/**
 * Reads a quotation page from the company website (Aura api_quote). The server only fetches pages
 * on the hosts in QUOTE_HOSTS (default aura.eg), over HTTPS, following at most three redirects that
 * stay on those hosts, for at most 8 seconds and 1 MB, so the feature cannot be used to reach other
 * servers.
 */

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 8_000;

export function quoteHosts(): string[] {
  return (process.env.QUOTE_HOSTS ?? "aura.eg,www.aura.eg")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ValidationError({ quoteUrl: msg("validation.url") }, msg("validation.url"));
  }
  // Plain http only for a local test server (QUOTE_ALLOW_HTTP=1).
  const httpOk = process.env.QUOTE_ALLOW_HTTP === "1" && url.protocol === "http:";
  if ((url.protocol !== "https:" && !httpOk) || url.username || url.password || !quoteHosts().includes(url.host.toLowerCase())) {
    const text = msg("quote.errors.host", { hosts: quoteHosts().join(", ") });
    throw new ValidationError({ quoteUrl: text }, text);
  }
  return url;
}

async function readLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new ValidationError({ quoteUrl: msg("quote.errors.tooLarge") }, msg("quote.errors.tooLarge"));
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

/** Fetches and reads a quotation; the full data, prices included (callers redact for the reader). */
export async function readQuote(raw: string): Promise<QuoteDTO> {
  let url = checkUrl(raw);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= 3; hop++) {
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", signal, headers: { accept: "text/html" }, cache: "no-store" });
    } catch {
      throw new ValidationError({ quoteUrl: msg("quote.errors.fetch") }, msg("quote.errors.fetch"));
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = checkUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    if (!res.ok) {
      const text = msg("quote.errors.status", { status: res.status });
      throw new ValidationError({ quoteUrl: text }, text);
    }
    const quote = parseQuote(await readLimited(res));
    if (!quote.items.length && !quote.number) throw new ValidationError({ quoteUrl: msg("quote.errors.empty") }, msg("quote.errors.empty"));
    return quote;
  }
  throw new ValidationError({ quoteUrl: msg("quote.errors.fetch") }, msg("quote.errors.fetch"));
}

/** Preview for the booking form. */
export async function previewQuote(user: CurrentUser, raw: unknown): Promise<QuoteDTO> {
  assertCan(user, "appointments.manage");
  const url = (raw as { url?: unknown })?.url;
  if (typeof url !== "string" || url.length > 500) throw new ValidationError({ quoteUrl: msg("validation.url") });
  return quoteForReader(await readQuote(url), canSeePrices(user));
}

/** Reads the quotation and keeps it on the visit (whoever manages the booking). */
export async function saveQuote(user: CurrentUser, appointmentId: string, raw: unknown): Promise<QuoteDTO> {
  assertCan(user, "appointments.manage");
  const url = (raw as { url?: unknown })?.url;
  if (typeof url !== "string" || url.length > 500) throw new ValidationError({ quoteUrl: msg("validation.url") });
  if (typeof appointmentId !== "string" || appointmentId.length > 64) throw new NotFoundError("errors.appointmentNotFound");
  const a = await prisma.appointment.findFirst({ where: { AND: [{ id: appointmentId }, appointmentScope(user)] }, select: { id: true, number: true, createdById: true, quoteUrl: true } });
  if (!a) throw new NotFoundError("errors.appointmentNotFound");
  if (!canManageAppointment(user, a)) throw new ForbiddenError();
  const quote = await readQuote(url);
  const clean = url.trim();
  await prisma.$transaction(async (tx) => {
    await tx.appointment.update({ where: { id: a.id }, data: { quoteUrl: clean, quoteData: quote, updatedById: user.id, version: { increment: 1 } } });
    await recordAudit(tx, {
      entityType: "APPOINTMENT",
      entityId: a.id,
      appointmentId: a.id,
      action: "QUOTE_READ",
      summary: msg("audit.quoteRead", { number: quote.number || "-", count: quote.count }),
      changes: { quoteUrl: { from: a.quoteUrl, to: clean }, items: quote.items.map((i) => `${i.qty} × ${i.name}`) },
      actorId: user.id,
    });
  });
  return quoteForReader(quote, canSeePrices(user));
}
