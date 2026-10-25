import type { Role, User } from "@prisma/client";
import { prisma } from "@/server/db";
import { permissionsFor } from "@/lib/permissions";
import type { CurrentUser } from "@/server/auth/session";
import { DEFAULT_SETTINGS } from "@/server/services/settings";
import type { SettingsValues } from "@/lib/validation";

export { prisma };

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE notifications, audit_logs, cash_custody, technician_leaves, appointment_technicians, appointments, customer_locations, customers,
      password_tokens, sessions, login_attempts, settings, appointment_statuses, users RESTART IDENTITY CASCADE`,
  );
}

export async function seedStatuses() {
  const defs = [
    { name: "Scheduled", kind: "SCHEDULED", color: "#2563EB", blocksSchedule: true, isDefault: true },
    { name: "In Progress", kind: "IN_PROGRESS", color: "#CA8A04", blocksSchedule: true },
    { name: "Completed", kind: "COMPLETED", color: "#059669", blocksSchedule: true },
    { name: "Postponed/Rescheduled", kind: "POSTPONED", color: "#7C3AED", blocksSchedule: true },
    { name: "Cancelled", kind: "CANCELLED", color: "#6B7280", blocksSchedule: false },
    { name: "Unable to Complete", kind: "UNABLE_TO_COMPLETE", color: "#DC2626", blocksSchedule: true },
    { name: "Needs another visit", kind: "NEEDS_REVISIT", color: "#EA580C", blocksSchedule: true },
  ] as const;
  const out: Record<string, string> = {};
  for (const [i, d] of defs.entries()) {
    const s = await prisma.appointmentStatus.create({ data: { ...d, isDefault: "isDefault" in d, sortOrder: i } });
    out[d.kind] = s.id;
  }
  return out as Record<(typeof defs)[number]["kind"], string>;
}

let counter = 0;
export async function makeUser(role: Role, overrides: Partial<User> = {}): Promise<User> {
  counter++;
  return prisma.user.create({
    data: {
      name: overrides.name ?? `${role.toLowerCase()} ${counter}`,
      email: overrides.email ?? `${role.toLowerCase()}${counter}@test.local`,
      role,
      isActive: overrides.isActive ?? true,
      color: overrides.color ?? (role === "SALES" ? "#2563EB" : null),
      viewerPermissions: overrides.viewerPermissions ?? [],
      passwordHash: overrides.passwordHash ?? null,
    },
  });
}

export function asCurrent(user: User, settings: Partial<SettingsValues> = {}): CurrentUser {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    color: user.color,
    isActive: user.isActive,
    viewerPermissions: user.viewerPermissions,
    permissions: [...permissionsFor(user, s)],
    settings: s,
    sessionId: "test",
  };
}

/** A valid appointment payload; tweak with overrides. Times are in the company timezone. */
export function appointmentPayload(overrides: Record<string, unknown> = {}) {
  return {
    customer: { name: "Test Customer", phone: "+20 100 123 4567", secondaryPhone: "" },
    location: {
      area: "New Cairo",
      streetAddress: "12 Road 90",
      building: "Mivida",
      apartment: "14B",
      floor: "3",
      accessInstructions: "Gate 2",
      mapUrl: "https://maps.app.goo.gl/abc123",
      latitude: "",
      longitude: "",
    },
    productCategory: "SMART_LOCK",
    brand: "Yale",
    model: "Linus L2",
    description: "Front door lock",
    requiredEquipment: "Drill",
    additionalNotes: "Bring shoe covers",
    internalNotes: "Deposit paid",
    date: "2030-03-10",
    startTime: "10:00",
    durationMinutes: 120,
    technicianIds: [] as string[],
    ...overrides,
  };
}
