import fs from "node:fs";
import path from "node:path";

/** Minimal .env reader (avoids a dotenv dependency). Real environment variables win. */
export function loadEnvFile() {
  const file = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2];
  }
}

export function testDatabaseUrl(): string {
  loadEnvFile();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set. Integration tests need a separate, disposable database.");
  if (url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL - the tests wipe it.");
  return url;
}
