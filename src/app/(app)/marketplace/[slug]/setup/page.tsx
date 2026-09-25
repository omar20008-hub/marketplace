import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { n8n } from "@/lib/n8n";
import { SetupWizard, type SetupRequirement } from "./wizard";

export const metadata = { title: "Add to workspace · Builder" };

export default async function SetupPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser();

  const product = await prisma.product.findUnique({
    where: { slug },
    include: { requirements: { orderBy: { sortOrder: "asc" } } },
  });
  if (!product) notFound();
  if (product.status !== "PUBLISHED") redirect(`/marketplace/${slug}`);

  const [accounts, adapters] = await Promise.all([
    prisma.connectedAccount.findMany({ where: { userId: user.id } }),
    prisma.storageAdapter.findMany(),
  ]);

  const byType = new Map(accounts.map((account) => [account.credentialType, account]));

  // The generated connection form. Fields come from n8n's own credential schema
  // so the user never types JSON, and the platform never guesses field names.
  const requirements: SetupRequirement[] = await Promise.all(
    product.requirements.map(async (requirement) => {
      const account = requirement.credentialType
        ? byType.get(requirement.credentialType)
        : undefined;
      const schema =
        requirement.providedBy === "USER" &&
        requirement.credentialType &&
        account?.status !== "ACTIVE"
          ? await n8n.credentialSchema(requirement.credentialType)
          : null;

      return {
        id: requirement.id,
        kind: requirement.kind,
        label: requirement.label,
        note: requirement.note,
        credentialType: requirement.credentialType,
        providedBy: requirement.providedBy,
        connected: account?.status === "ACTIVE",
        accountRef: account?.accountRef ?? null,
        fields: schema
          ? Object.entries(schema.properties).map(([name, property]) => ({
              name,
              label: property.title ?? name,
              description: property.description ?? null,
              secret: property.format === "password",
              required: schema.required?.includes(name) ?? false,
            }))
          : [],
      };
    }),
  );

  return (
    <SetupWizard
      product={{
        id: product.id,
        slug: product.slug,
        title: product.title,
        version: product.version,
        invocationMode: product.invocationMode,
      }}
      requirements={requirements}
      // Only destinations with an active adapter are offered. A disabled one is
      // not shown at all, rather than shown and refused.
      backends={adapters
        .filter((adapter) => adapter.active)
        .map((adapter) => ({ backend: adapter.backend, label: adapter.displayName }))}
    />
  );
}
