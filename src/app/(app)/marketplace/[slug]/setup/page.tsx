import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { n8n } from "@/lib/n8n";
import {
  fallbackCredentialSchema,
  isPlatformOAuth,
  knownCredentialSchema,
  oauthStartUrl,
} from "@/lib/credentials";
import { CONNECT_ERRORS } from "@/lib/google-oauth";
import { SetupWizard, type SetupRequirement } from "./wizard";

export const metadata = { title: "Add to workspace · Builder" };

export default async function SetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ connected?: string; connect_error?: string }>;
}) {
  const { slug } = await params;
  const { connected, connect_error: connectError } = await searchParams;
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
      // A connection the platform holds through its own sign-in flow has no
      // fields to fill in — the wizard shows a button instead.
      const platformOAuth =
        requirement.providedBy === "USER" &&
        requirement.credentialType !== null &&
        isPlatformOAuth(requirement.credentialType) &&
        account?.status !== "ACTIVE";

      const schema =
        !platformOAuth &&
        requirement.providedBy === "USER" &&
        requirement.credentialType &&
        account?.status !== "ACTIVE"
          ? (knownCredentialSchema(requirement.credentialType) ??
            (await n8n.credentialSchema(requirement.credentialType)) ??
            fallbackCredentialSchema(requirement.credentialType))
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
        connectUrl: platformOAuth ? oauthStartUrl(`/marketplace/${slug}/setup`) : null,
        connectLabel: account?.status === "EXPIRED" ? "Reconnect" : "Connect",
        fields: schema
          ? Object.entries(schema.properties).map(([name, property]) => ({
              name,
              label: property.title ?? name,
              description: property.description ?? null,
              secret: property.format === "password",
              required: schema.required?.includes(name) ?? false,
              default:
                typeof property.default === "string" ? property.default : null,
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
      notice={
        connectError
          ? { tone: "error", text: CONNECT_ERRORS[connectError] ?? CONNECT_ERRORS.google }
          : connected
            ? { tone: "ok", text: "Connected." }
            : null
      }
      // Only destinations with an active adapter are offered. A disabled one is
      // not shown at all, rather than shown and refused.
      backends={adapters
        .filter((adapter) => adapter.active)
        .map((adapter) => ({ backend: adapter.backend, label: adapter.displayName }))}
    />
  );
}
