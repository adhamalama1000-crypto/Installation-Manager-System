import { execSync } from "node:child_process";
import { testDatabaseUrl } from "./load-env";

export default function setup() {
  const url = testDatabaseUrl();
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
}
