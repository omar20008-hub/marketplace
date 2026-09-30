import { prisma } from "@/lib/db";

/** A published product and the user's active installation of it. */
export async function seedInstallation(
  userId: string,
  { key = Math.random().toString(36).slice(2, 8), knowledgeKeyHash }: { key?: string; knowledgeKeyHash?: string } = {},
) {
  const product = await prisma.product.create({
    data: {
      slug: `p-${key}`,
      creatorId: userId,
      title: "Chat with your files",
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Knowledge",
      status: "PUBLISHED",
      templateId: `tpl_${key}`,
    },
  });
  return prisma.installation.create({
    data: {
      userId,
      productId: product.id,
      pinnedVersion: "1.0",
      status: "ACTIVE",
      installationId: `inst_${key}`,
      knowledgeKeyHash,
    },
  });
}
