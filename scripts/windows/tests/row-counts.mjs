// Test helper: prints "<users>,<customers>,<statuses>" so the launcher scenarios can prove that no
// start, stop, restart or failure ever changes the data. Read-only.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?(.*?)"?\s*$/);
  if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
try {
  const counts = await Promise.all([prisma.user.count(), prisma.customer.count(), prisma.appointmentStatus.count()]);
  console.log(counts.join(","));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
