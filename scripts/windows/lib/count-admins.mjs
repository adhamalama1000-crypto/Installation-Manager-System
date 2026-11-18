// Prints ADMINS=<number of active Admin accounts>. Used by setup-or-vip.ps1 to decide whether a
// first Admin account must be created. Reads nothing else and changes nothing.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Load the program folder's .env like the app does (values already in the environment win).
const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#") || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
try {
  console.log(`ADMINS=${await prisma.user.count({ where: { role: "ADMIN", isActive: true } })}`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
