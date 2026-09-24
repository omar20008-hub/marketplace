import "dotenv/config";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { testDatabaseUrl } from "./test-database-url";

/**
 * Creates the database the tests run against, and brings it up to the current
 * migration. Safe to run repeatedly.
 */

async function main() {
  const target = testDatabaseUrl();
  const url = new URL(target);
  const name = decodeURIComponent(url.pathname.slice(1));

  // Connect to the server's default database to issue CREATE DATABASE.
  const admin = new URL(target);
  admin.pathname = "/postgres";
  admin.search = "";

  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [name],
    );
    if (rowCount === 0) {
      // The name comes from our own connection string, not from user input,
      // and CREATE DATABASE cannot take a bound parameter.
      await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      console.log(`Created ${name}.`);
    } else {
      console.log(`${name} already exists.`);
    }
  } finally {
    await client.end();
  }

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: target },
  });

  console.log(`\nReady. Run the suite with: npm test`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
