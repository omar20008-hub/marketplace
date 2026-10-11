import { prisma } from "@/lib/db";
import { isOnDemand } from "@/lib/invocation-mode";

/**
 * The tools the Orchestrator may call for one user, read from their own active
 * installations. Not a "use server" module: userId is a parameter, so exporting
 * this from an action module would let a caller name any user's catalog.
 */

export type CatalogEntry = {
  installationId: string;
  title: string;
  description: string;
  actionType: "read" | "write";
  fields: string[];
};

type InputField = { name: string; type?: string; system?: boolean };

function fieldsOf(inputSchema: unknown): string[] {
  if (!Array.isArray(inputSchema)) return [];
  return (inputSchema as InputField[])
    .filter((field) => !field.system)
    .map((field) => `${field.name} (${field.type || "string"})`);
}

export async function toolCatalog(userId: string): Promise<CatalogEntry[]> {
  const installations = await prisma.installation.findMany({
    where: { userId, status: "ACTIVE", product: { status: "PUBLISHED" } },
    include: { product: true },
    orderBy: { installedAt: "asc" },
  });

  return installations
    .filter((installation) => isOnDemand(installation.product.invocationMode))
    .map((installation) => ({
      installationId: installation.id,
      title: installation.product.title,
      description: installation.product.description,
      actionType: installation.product.actionType === "WRITE" ? "write" : "read",
      fields: fieldsOf(installation.product.inputSchema),
    }));
}

export function renderCatalog(entries: CatalogEntry[]): string {
  if (entries.length === 0) return "لا توجد أدوات مفعّلة لهذا المستخدم.";

  return entries
    .map(
      (entry) =>
        `- installationId: ${entry.installationId} | الاسم: ${entry.title} | متى يُستخدم: ${entry.description} | نوع الإجراء: ${entry.actionType} | الحقول المطلوبة: ${entry.fields.length > 0 ? entry.fields.join(", ") : "لا يوجد"}`,
    )
    .join("\n");
}
