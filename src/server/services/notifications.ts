import "server-only";
import { Prisma } from "@prisma/client";
import { decodeMessage, msg, translateMessage } from "@/i18n/translate";
import { prisma, type Db } from "../db";
import type { CurrentUser } from "../auth/session";

/**
 * `message` may be a message descriptor (`msg(key, params)`): the English text is stored for
 * search and older clients, and the descriptor in `params` so each reader sees their language.
 */
export async function notifyUsers(
  db: Db,
  userIds: string[],
  data: { appointmentId?: string | null; type: string; message: string },
  excludeUserId?: string,
) {
  const recipients = [...new Set(userIds)].filter((id) => id !== excludeUserId);
  if (!recipients.length) return;
  const stored = storedNotification(data.message);
  await db.notification.createMany({
    data: recipients.map((userId) => ({
      userId,
      appointmentId: data.appointmentId ?? null,
      type: data.type,
      ...stored,
    })),
  });
}

/** The stored columns of a notification written directly (English text plus the descriptor). */
export function storedNotification(message: string): { message: string; params: Prisma.InputJsonValue | typeof Prisma.DbNull } {
  const descriptor = decodeMessage(message);
  return {
    message: translateMessage(message, "en").slice(0, 500),
    params: descriptor ? (descriptor as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
  };
}

/** The message to show: the stored descriptor when there is one (translated by the client). */
export function storedMessage(text: string, params: Prisma.JsonValue | null): string {
  if (params && typeof params === "object" && !Array.isArray(params) && typeof params.key === "string") {
    const p = params as { key: Parameters<typeof msg>[0]; params?: Parameters<typeof msg>[1] };
    return msg(p.key, p.params);
  }
  return text;
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
      message: n.message,
      /** What to show: a message descriptor translated by the reader's interface. */
      display: storedMessage(n.message, n.params),
      appointmentId: n.appointmentId,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
  };
}

export async function markNotificationsRead(user: CurrentUser, ids?: string[]) {
  await prisma.notification.updateMany({
    where: { userId: user.id, readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  });
}
