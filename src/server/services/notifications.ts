import "server-only";
import { prisma, type Db } from "../db";
import type { CurrentUser } from "../auth/session";

export async function notifyUsers(
  db: Db,
  userIds: string[],
  data: { appointmentId?: string | null; type: string; message: string },
  excludeUserId?: string,
) {
  const recipients = [...new Set(userIds)].filter((id) => id !== excludeUserId);
  if (!recipients.length) return;
  await db.notification.createMany({
    data: recipients.map((userId) => ({
      userId,
      appointmentId: data.appointmentId ?? null,
      type: data.type,
      message: data.message.slice(0, 500),
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
      message: n.message,
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
