import "server-only";
import { prisma } from "@/lib/db";

/**
 * Keeps the workspace honest: a product whose connection just came back should
 * stop saying it needs attention, and one whose connection just went should say
 * so before the next scheduled run fails.
 *
 * Lives outside server/account-actions.ts because a "use server" file may only
 * export actions, and this is also called when a connection dies in the
 * background (an expired Google token), with no user clicking anything.
 */
export async function refreshInstallationStates(userId: string) {
  const [installations, accounts] = await Promise.all([
    prisma.installation.findMany({
      where: { userId, status: { in: ["ACTIVE", "PARTIAL"] } },
      include: { product: { include: { requirements: true } } },
    }),
    prisma.connectedAccount.findMany({ where: { userId } }),
  ]);

  const usable = new Set(
    accounts.filter((a) => a.status === "ACTIVE").map((a) => a.credentialType),
  );

  for (const installation of installations) {
    const missing = installation.product.requirements
      .filter((r) => r.providedBy === "USER" && r.credentialType)
      .filter((r) => !usable.has(r.credentialType!))
      .map((r) => r.label);

    const isPartial = missing.length > 0;
    if (
      (isPartial && installation.status === "PARTIAL") ||
      (!isPartial && installation.status === "ACTIVE" && !installation.attentionNote)
    ) {
      continue;
    }

    await prisma.installation.update({
      where: { id: installation.id },
      data: {
        status: isPartial ? "PARTIAL" : installation.installationId ? "ACTIVE" : "PARTIAL",
        attentionNote: isPartial
          ? `${missing.join(", ")} still needs connecting.`
          : null,
      },
    });
  }
}
