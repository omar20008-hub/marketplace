import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
// From lib/password.ts rather than lib/auth.ts: the latter begins with
// `import "server-only"`, which a script cannot load. Same function either way.
import { hashPassword } from "../src/lib/password";

/**
 * Creates the first account on a fresh deployment.
 *
 * There is no sign-up flow — deliberately, for now: this is a marketplace with
 * a review queue, not a service anyone should be able to open an account on
 * before someone has decided who may. And `db:seed` refuses to run in
 * production, because it deletes every row in nineteen tables and creates demo
 * accounts whose password is written in the file.
 *
 * Which leaves a fresh production database with nobody in it and no way in.
 * This is that way in: a one-off operator action, run once from the host's
 * shell or a one-off job, rather than an endpoint that exists forever for the
 * sake of a single use.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" \
 *   ADMIN_PASSWORD='...' npx tsx scripts/create-admin.ts
 *
 * The password is read from the environment and never printed. Passing it on
 * the command line would put it in the shell history and in the host's job log,
 * which is a worse place for it than anywhere this script could put it.
 */

const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
const name = (process.env.ADMIN_NAME ?? "").trim();
const password = process.env.ADMIN_PASSWORD ?? "";

/** Matches lib/env.ts, which will not start on a short secret either. */
const MIN_PASSWORD_LENGTH = 12;

function refuse(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!email || !email.includes("@")) {
  refuse("Set ADMIN_EMAIL to the address this account signs in with.");
}
if (!name) {
  refuse("Set ADMIN_NAME to the name shown in the sidebar.");
}
if (password.length < MIN_PASSWORD_LENGTH) {
  refuse(
    `Set ADMIN_PASSWORD to at least ${MIN_PASSWORD_LENGTH} characters. ` +
      "This is the only account on the deployment and it can review, suspend " +
      "and restrict every product on it.",
  );
}

/** From the name: "Nora Haddad" becomes NH, "Nora" becomes NO. */
function initialsFor(fullName: string): string {
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return parts[0].slice(0, 2).toUpperCase();
}

const FREE_PLAN = {
  id: "free",
  name: "Free",
  monthlyRuns: 100,
  storageBytes: BigInt(1_000_000_000),
  monthlyCredits: 0,
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) refuse("Missing DATABASE_URL.");

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      // Not an update. Silently resetting someone's password from a deploy
      // script is how an account gets taken over by whoever can run jobs.
      refuse(
        `${email} already has an account. This script only creates; change a ` +
          "password from the account screen.",
      );
    }

    // A user needs a plan, and a fresh database has none. Created only if it is
    // absent, so running this twice cannot rewrite the limits on a live plan.
    const plan = await prisma.plan.upsert({
      where: { id: FREE_PLAN.id },
      create: FREE_PLAN,
      update: {},
    });

    const user = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash: await hashPassword(password),
        initials: initialsFor(name),
        planId: plan.id,
        roles: ["USER", "ADMIN"],
      },
    });

    const total = await prisma.user.count();

    console.log(`\nCreated ${user.email} as USER and ADMIN on the "${plan.name}" plan.`);
    console.log(`There ${total === 1 ? "is" : "are"} now ${total} account(s) on this deployment.`);
    console.log("Sign in at /login with the password you set.\n");
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
