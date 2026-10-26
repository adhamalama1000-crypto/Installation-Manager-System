import "server-only";
import type { Prisma } from "@prisma/client";
import type { Locale } from "@/i18n/config";
import { createT } from "@/i18n/translator";
import { prisma, type Db } from "../db";
import type { CurrentUser } from "../auth/session";

const english = createT("en");

/** Splits an encoded message (see i18n `msg`) into a stored key + params, or null for plain text. */
export function messageData(encoded: string): Prisma.InputJsonValue | undefined {
  const bar = encoded.indexOf("|");
  const key = bar === -1 ? encoded : encoded.slice(0, bar);
  if (english.msg(key) === key) return undefined;
  return { key, params: bar === -1 ? {} : (JSON.parse(encoded.slice(bar + 1)) as Prisma.InputJsonObject) };
}

/** `message` is an encoded message: the English text is stored for search/legacy, and the key + params so each reader sees their language. */
export async function notifyUsers(
  db: Db,
  userIds: string[],
  data: { appointmentId?: string | null; type: string; message: string },
  excludeUserId?: string,
) {
  const recipients = [...new Set(userIds)].filter((id) => id !== excludeUserId);
  if (!recipients.length) return;
  const text = english.msg(data.message).slice(0, 500);
  const stored = messageData(data.message);
  await db.notification.createMany({
    data: recipients.map((userId) => ({
      userId,
      appointmentId: data.appointmentId ?? null,
      type: data.type,
      message: text,
      ...(stored ? { data: stored } : {}),
    })),
  });
}

export async function listNotifications(user: CurrentUser, limit = 20) {
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 50),
    }),
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);
  return {
    unread,
    items: items.map((n) => ({
      id: n.id,
      type: n.type,
      message: localized(n.data, n.message, user.locale),
      appointmentId: n.appointmentId,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
  };
}

/** Text of a stored {key, params} in `locale`; rows written before translations keep their text. */
export function localized(data: Prisma.JsonValue | null, fallback: string, locale: Locale): string {
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.key !== "string") return fallback;
  const params = data.params && typeof data.params === "object" && !Array.isArray(data.params) ? (data.params as Record<string, string | number>) : undefined;
  return createT(locale).dyn(data.key, params, fallback);
}

export async function markNotificationsRead(user: CurrentUser, ids?: string[]) {
  await prisma.notification.updateMany({
    where: { userId: user.id, readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  });
}
