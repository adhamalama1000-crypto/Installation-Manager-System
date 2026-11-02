/**
 * Recover access to admin@example.com: check its state, or set a new password for it. Changes no
 * other account and no business data; never deletes users. See scripts/admin-password.ts.
 *
 *   npm run reset-admin-password -- --check        read-only: is the account there, active, locked out?
 *   npm run reset-admin-password                   asks for the new password twice (hidden), then sets it
 *   npm run reset-admin-password -- --activate     also switches the account back on if it was deactivated
 *   NEW_ADMIN_PASSWORD='...' npm run reset-admin-password -- --yes    without prompts (e.g. in a script)
 *
 * On Windows PowerShell, run npm as npm.cmd. The password is never printed.
 */
import { PrismaClient } from "@prisma/client";
import { ADMIN_EMAIL, adminStatus, describeDatabase, passwordProblem, resetAdminPassword } from "./admin-password";

const args = new Set(process.argv.slice(2));
const prisma = new PrismaClient();

/** Reads a line from the terminal without echoing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error("There is no terminal to type the password in. Set NEW_ADMIN_PASSWORD and pass --yes instead."));
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") return finish();
        if (c === "\u0003") return finish(new Error("Cancelled. Nothing was changed."));
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else if (c >= " ") value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function printStatus() {
  const s = await adminStatus(prisma);
  console.log(`Database:            ${describeDatabase(process.env.DATABASE_URL)}`);
  console.log(`Users in database:   ${await prisma.user.count()}`);
  console.log(`${ADMIN_EMAIL}: ${s.exists ? "exists" : "MISSING"}`);
  if (s.exists) {
    console.log(`  role:              ${s.role}`);
    console.log(`  active:            ${s.isActive ? "yes" : "NO (sign-in is refused; use --activate)"}`);
    console.log(`  has a password:    ${s.hasPassword ? "yes" : "NO"}`);
    console.log(`  open sessions:     ${s.sessions}`);
  }
  console.log(`  failed sign-ins in the last 15 min: ${s.recentFailures}${s.emailLocked ? " (LOCKED OUT until 15 minutes after the last one)" : ""}`);
  if (s.lockedAddresses.length) console.log(`  addresses locked out (30 failures in 15 min): ${s.lockedAddresses.join(", ")}`);
  return s;
}

async function main() {
  if (args.has("--check")) {
    await printStatus();
    return;
  }
  const status = await printStatus();
  if (!status.exists) throw new Error(`There is no account ${ADMIN_EMAIL}. Nothing was changed. (npm run create-admin creates an Admin.)`);
  if (status.role !== "ADMIN") throw new Error(`${ADMIN_EMAIL} is not an Admin account. Nothing was changed.`);

  let password = process.env.NEW_ADMIN_PASSWORD ?? "";
  if (password) {
    if (!args.has("--yes")) throw new Error("NEW_ADMIN_PASSWORD is set: pass --yes to confirm the reset. Nothing was changed.");
  } else {
    password = await askHidden(`New password for ${ADMIN_EMAIL}: `);
    const problem = passwordProblem(password);
    if (problem) throw new Error(`${problem} Nothing was changed.`);
    if ((await askHidden("Type it again: ")) !== password) throw new Error("The two passwords differ. Nothing was changed.");
  }
  const r = await resetAdminPassword(prisma, { password, activate: args.has("--activate") });
  console.log(`\nPassword updated for ${ADMIN_EMAIL}.`);
  if (r.activated) console.log("The account was deactivated and is now active again.");
  else if (!r.isActive) console.log("Note: the account is still DEACTIVATED, so sign-in stays refused. Run again with --activate.");
  console.log(`Cleared ${r.clearedFailures} failed sign-in record(s) for this email; ended ${r.endedSessions} session(s).`);
  console.log("Recorded in the audit log. No other account or data was changed.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
