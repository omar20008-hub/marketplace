import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { n8n } from "@/lib/n8n";
import { Badge, ButtonLink, Card, PageTitle } from "@/components/ds";
import { disconnectAccount } from "@/server/account-actions";
import { ConnectPanel, type Connectable } from "./connect-panel";

export const metadata = { title: "Connected accounts · Builder" };

/**
 * What each connection is allowed to do, in the user's words. The design puts
 * this in front of the consent step on purpose — a scope list is the one thing
 * a person needs before handing over access.
 */
const ALLOWS: Record<string, { grants: string[]; denies: string[] }> = {
  facebookGraphApi: {
    grants: ["Publish posts and stories", "Read your post insights"],
    denies: ["No access to messages or followers"],
  },
  slackApi: {
    grants: ["Post to the channels you name"],
    denies: ["No access to direct messages"],
  },
  hubspotApi: {
    grants: ["Read and update the records a product touches"],
    denies: ["No access to billing or user administration"],
  },
  googleSheetsOAuth2Api: {
    grants: ["Read and write the sheets you name"],
    denies: ["No access to the rest of your Drive"],
  },
  openAiApi: {
    grants: ["Send prompts on your behalf"],
    denies: ["No access to your account settings"],
  },
};

const CONNECTABLE: { credentialType: string; displayName: string }[] = [
  { credentialType: "facebookGraphApi", displayName: "Instagram Business" },
  { credentialType: "slackApi", displayName: "Slack" },
  { credentialType: "hubspotApi", displayName: "HubSpot" },
  { credentialType: "openAiApi", displayName: "AI model" },
];

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ connect?: string }>;
}) {
  const { connect } = await searchParams;
  const user = await requireUser();

  const accounts = await prisma.connectedAccount.findMany({
    where: { userId: user.id },
    // secretJson is deliberately absent from this selection.
    select: {
      id: true,
      credentialType: true,
      displayName: true,
      initials: true,
      accountRef: true,
      scope: true,
      status: true,
      expiresAt: true,
      links: { select: { installationId: true } },
    },
    orderBy: [{ status: "asc" }, { displayName: "asc" }],
  });

  const usedBy = await prisma.installationCredential.groupBy({
    by: ["credentialType"],
    _count: { _all: true },
  });
  const useCount = new Map(usedBy.map((row) => [row.credentialType, row._count._all]));

  const connectable: Connectable[] = await Promise.all(
    CONNECTABLE.map(async (item) => {
      const schema = await n8n.credentialSchema(item.credentialType);
      return {
        credentialType: item.credentialType,
        displayName: item.displayName,
        allows: ALLOWS[item.credentialType] ?? { grants: [], denies: [] },
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

  const connected = accounts.filter((a) => a.status !== "PENDING").length;

  return (
    <div className="px-5 py-5 lg:px-7">
      <PageTitle title="Connected accounts" meta={`· ${connected} connected`} />

      <div className="mt-5 grid grid-cols-1 gap-7 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-2">
          {accounts.map((account) => {
            const uses = useCount.get(account.credentialType) ?? 0;
            return (
              <Card key={account.id} className="flex flex-wrap items-center gap-3 p-3.5">
                <span className="flex size-10 flex-none items-center justify-center rounded-row bg-fill text-xs font-medium text-ink-2">
                  {account.initials}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{account.displayName}</div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    {account.status === "EXPIRED"
                      ? "Access expired. Scheduled runs that need it are blocked."
                      : account.scope === "PLATFORM"
                        ? uses > 0
                          ? `Platform connection · used by ${uses} product${uses === 1 ? "" : "s"}`
                          : "Platform connection · no action needed"
                        : account.status === "PENDING"
                          ? "Not connected."
                          : [
                              account.accountRef,
                              uses > 0
                                ? `used by ${uses} product${uses === 1 ? "" : "s"}`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                  </div>
                </div>

                {account.status === "EXPIRED" ? (
                  <ButtonLink
                    href={`/accounts?connect=${account.credentialType}`}
                    size="sm"
                  >
                    Reconnect
                  </ButtonLink>
                ) : account.scope === "PLATFORM" ? (
                  <Badge tone="platform">Platform</Badge>
                ) : account.status === "PENDING" ? (
                  <Badge tone="partial">Not connected</Badge>
                ) : (
                  <>
                    <Badge tone="ready">Active</Badge>
                    <form action={disconnectAccount}>
                      <input type="hidden" name="accountId" value={account.id} />
                      <button
                        type="submit"
                        className="text-[13px] text-ink-2 hover:text-danger-ink"
                      >
                        Revoke
                      </button>
                    </form>
                  </>
                )}
              </Card>
            );
          })}
        </div>

        <ConnectPanel options={connectable} preselect={connect} />
      </div>
    </div>
  );
}
