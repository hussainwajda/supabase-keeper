/**
 * Give a user a password.
 *
 *   pnpm set-password -- you@example.com
 *   pnpm set-password -- you@example.com --password 'correct horse battery staple'
 *
 * Needed after migrating from Supabase: Supabase Auth stored a bcrypt hash that this backend
 * deliberately doesn't try to read or verify, so a migrated account arrives with no password.
 * It also doubles as the way back in when nobody can sign in.
 *
 * Reading the password from a prompt rather than requiring it as an argument, because an
 * argument lands in the shell history and in the process list where any other user on the
 * machine can read it.
 */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { closeMongo, connectMongo } from "../src/db/client";
import { ensureIndexes } from "../src/db/indexes";
import { users } from "../src/db/collections";
import { hashPassword, passwordProblem } from "../src/auth/password";
import { authSessions } from "../src/db/collections";

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
  if (!email) {
    console.error("Usage: pnpm set-password -- you@example.com [--password <pw>] [--generate]");
    process.exit(1);
  }

  await connectMongo();
  await ensureIndexes();

  const user = await users().findOne({ email });
  if (!user) {
    const known = await users().find({}).project<{ email: string }>({ email: 1 }).toArray();
    console.error(
      `\nNo user with that email.${known.length ? `\n\nAccounts in this database:\n${known.map((u) => `  ${u.email}`).join("\n")}` : "\n\nThis database has no users yet — sign up through POST /auth/signup."}\n`,
    );
    await closeMongo();
    process.exit(1);
  }

  const flagIndex = args.indexOf("--password");
  let password =
    flagIndex !== -1 ? args[flagIndex + 1] : args.includes("--generate") ? randomBytes(18).toString("base64url") : "";
  const generated = args.includes("--generate") && !password.startsWith("-") && flagIndex === -1;

  if (!password) password = await prompt(`New password for ${email}: `);

  const problem = passwordProblem(password);
  if (problem) {
    console.error(`\n${problem}\n`);
    await closeMongo();
    process.exit(1);
  }

  await users().updateOne(
    { _id: user._id },
    { $set: { password_hash: hashPassword(password), updated_at: new Date() } },
  );

  // A password change invalidates existing sessions, here as in POST /auth/password: the
  // usual reason to set one from the command line is that something went wrong.
  const { deletedCount } = await authSessions().deleteMany({ user_id: user._id });

  console.log(`\nPassword set for ${email}.`);
  if (generated) console.log(`Generated password: ${password}`);
  if (deletedCount) console.log(`${deletedCount} existing session(s) signed out.`);
  console.log();

  await closeMongo();
}

main().catch(async (e) => {
  console.error(`\nFailed: ${(e as Error).message}\n`);
  await closeMongo().catch(() => {});
  process.exit(1);
});
