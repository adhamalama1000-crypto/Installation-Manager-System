import "server-only";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { settingsSchema, type SettingsValues, fieldErrorsFromZod } from "@/lib/validation";
import { prisma, type Db } from "../db";
import { ValidationError } from "../errors";
import { recordAudit, diffValues } from "./audit";
import type { CurrentUser } from "../auth/session";
import { assertCan } from "../access";

const SETTINGS_KEY = "general";

export const DEFAULT_SETTINGS: SettingsValues = {
  timezone: DEFAULT_TIMEZONE,
  weekStartsOn: 6, // Saturday - the common working week start in Egypt
  dayStartHour: 8,
  dayEndHour: 22,
  defaultDurationMinutes: 120,
  travelBufferMinutes: 0,
  salesCanViewReports: true,
  salesCanEditOthersAppointments: true,
  technicianCanSeeContacts: true,
};

export async function getSettings(db: Db = prisma): Promise<SettingsValues> {
  const row = await db.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULT_SETTINGS };
  const parsed = settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...(row.value as object) });
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
}

export async function updateSettings(actor: CurrentUser, input: unknown): Promise<SettingsValues> {
  assertCan(actor, "settings.manage");
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  return prisma.$transaction(async (tx) => {
    const before = await getSettings(tx);
    await tx.setting.upsert({
      where: { key: SETTINGS_KEY },
      create: { key: SETTINGS_KEY, value: parsed.data, updatedById: actor.id },
      update: { value: parsed.data, updatedById: actor.id },
    });
    const changes = diffValues(before, parsed.data);
    if (Object.keys(changes).length) {
      await recordAudit(tx, {
        entityType: "SETTINGS",
        entityId: SETTINGS_KEY,
        action: "SETTINGS_UPDATED",
        summary: `Updated system settings (${Object.keys(changes).join(", ")})`,
        changes,
        actorId: actor.id,
      });
    }
    return parsed.data;
  });
}
