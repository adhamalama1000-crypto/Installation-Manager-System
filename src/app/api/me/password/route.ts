import { msg } from "@/i18n/translator";
import { changePasswordSchema, fieldErrorsFromZod } from "@/lib/validation";
import { prisma } from "@/server/db";
import { ValidationError } from "@/server/errors";
import { apiRoute, readJson } from "@/server/http";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { deleteUserSessions } from "@/server/auth/session";
import { recordAudit } from "@/server/services/audit";

export const POST = apiRoute(async ({ req, user }) => {
  const parsed = changePasswordSchema.safeParse(await readJson(req));
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  if (!(await verifyPassword(parsed.data.currentPassword, row.passwordHash))) {
    throw new ValidationError({ currentPassword: msg("userErrors.wrongPassword") });
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(parsed.data.newPassword), passwordChangedAt: new Date() },
  });
  await recordAudit(prisma, {
    entityType: "USER",
    entityId: user.id,
    action: "USER_PASSWORD_CHANGED",
    summary: msg("audit.passwordChanged", { name: user.name }),
    actorId: user.id,
  });
  // Sign out every other device.
  await deleteUserSessions(user.id, user.sessionId);
  return { ok: true };
});
