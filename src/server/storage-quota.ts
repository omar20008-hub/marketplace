import "server-only";
import { prisma } from "@/lib/db";
import { formatBytes } from "@/lib/readiness";

/**
 * The storage a plan allows, and what the person's saved results already use. The
 * workspace and results pages show the same numbers; this is where the platform
 * enforces them, so a full plan stops a run before it is paid for, and a result that
 * would overflow is not written at all.
 */

export async function storageUsedBytes(userId: string): Promise<number> {
  const total = await prisma.artifact.aggregate({
    where: { run: { userId } },
    _sum: { sizeBytes: true },
  });
  return total._sum.sizeBytes ?? 0;
}

/** Whether `bytes` more can be saved without going past the plan. */
export function fitsInPlan(usedBytes: number, quotaBytes: number, bytes: number): boolean {
  return usedBytes + bytes <= quotaBytes;
}

export function storageFullMessage(usedBytes: number, quotaBytes: number, planName: string) {
  return `Your saved results take ${formatBytes(usedBytes)} of the ${formatBytes(quotaBytes)} on ${planName}. Remove old results or upgrade before running again. This run was stopped before anything was spent.`;
}
