import "server-only";
import { prisma } from "@/lib/db";
import { probeN8nApi } from "@/lib/n8n/live";
import { installReadyProducts } from "@/server/auto-install";

/**
 * The hourly check on the n8n connection, and the catch-up that goes with it.
 *
 * It asks n8n whether the platform's key is accepted. The answer is stored where an
 * admin can see it (PlatformStatus, shown on the Health tab). While the key is refused,
 * nothing is installed for anyone, because every install would fail the same way. When
 * the key is accepted again, people who signed up while it was refused are given the
 * products they missed. Each step is idempotent: a product already installed is skipped,
 * so running this every hour costs one request and a few queries.
 */

export const N8N_STATUS_KEY = "n8n.api";
/** How far back a sign-up still gets its catch-up install. */
const CATCH_UP_DAYS = 7;
/** People handled per run, so one run stays short when many missed out. */
const CATCH_UP_BATCH = 8;

export type N8nApiStatus = {
  state: "ok" | "rejected" | "unreachable" | "unconfigured";
  checkedAt: string;
  /** When the current state began, so a long outage is visible as long. */
  since: string;
  caughtUp: number;
};

export async function runN8nCanary(now = new Date()): Promise<N8nApiStatus> {
  const previous = await prisma.platformStatus.findUnique({ where: { key: N8N_STATUS_KEY } });
  const before = previous?.value as N8nApiStatus | undefined;

  const state = await probeN8nApi();
  const since = before && before.state === state ? before.since : now.toISOString();
  let caughtUp = 0;

  // "unconfigured" means there is no REST key to test, so installs are not held back
  // and the catch-up runs: its own results are the signal (see auto-install.ts).
  if (state === "ok" || state === "unconfigured") {
    const window = new Date(now.getTime() - CATCH_UP_DAYS * 24 * 60 * 60 * 1000);
    const missed = await prisma.user.findMany({
      where: { createdAt: { gte: window }, installations: { none: {} } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: CATCH_UP_BATCH,
    });
    for (const person of missed) {
      const result = await installReadyProducts(person.id);
      caughtUp += result.installed.length;
    }
  }

  const status: N8nApiStatus = { state, checkedAt: now.toISOString(), since, caughtUp };
  await prisma.platformStatus.upsert({
    where: { key: N8N_STATUS_KEY },
    create: { key: N8N_STATUS_KEY, value: status },
    update: { value: status },
  });
  if (state === "rejected" || state === "unreachable") {
    console.error(`n8n API ${state}: installs are paused until it answers again`);
  }
  return status;
}
