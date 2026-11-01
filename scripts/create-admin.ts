/**
 * Creates (or re-activates) an Admin account. Intended for the first deployment, where the demo
 * seed must not be used.
 *
 *   ADMIN_EMAIL=owner@company.com ADMIN_NAME="Owner" ADMIN_PASSWORD='a-strong-password1' npm run create-admin
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const name = (process.env.ADMIN_NAME ?? "Administrator").trim();
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Set ADMIN_EMAIL to a valid email address.");
  if (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error("ADMIN_PASSWORD must be at least 10 characters and contain letters and numbers.");
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name, role: "ADMIN", passwordHash, passwordChangedAt: new Date(), color: "#7C3AED" },
    update: { role: "ADMIN", isActive: true, passwordHash, passwordChangedAt: new Date() },
  });
  if ((await prisma.appointmentStatus.count()) === 0) {
    const defaults = [
      { name: "Scheduled", nameAr: "مجدول", kind: "SCHEDULED", color: "#2563EB", blocksSchedule: true, isDefault: true },
      { name: "In Progress", nameAr: "قيد التنفيذ", kind: "IN_PROGRESS", color: "#CA8A04", blocksSchedule: true },
      { name: "Completed", nameAr: "تم التنفيذ", kind: "COMPLETED", color: "#059669", blocksSchedule: true },
      { name: "Postponed/Rescheduled", nameAr: "مؤجل / ميعاد جديد", kind: "POSTPONED", color: "#7C3AED", blocksSchedule: true },
      { name: "Cancelled", nameAr: "ملغي", kind: "CANCELLED", color: "#6B7280", blocksSchedule: false },
      { name: "Unable to Complete", nameAr: "تعذّر التنفيذ", kind: "UNABLE_TO_COMPLETE", color: "#DC2626", blocksSchedule: true },
    ] as const;
    for (const [i, s] of defaults.entries()) {
      await prisma.appointmentStatus.create({ data: { ...s, isDefault: "isDefault" in s, sortOrder: i * 10 } });
    }
    console.log("Created the default appointment statuses.");
  }
  console.log(`Admin account ready: ${user.email}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
