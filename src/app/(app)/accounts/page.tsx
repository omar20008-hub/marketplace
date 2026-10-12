import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { n8n } from "@/lib/n8n";
import {
  GOOGLE_DRIVE_CREDENTIAL,
  hasFacebookSignIn,
  knownCredentialSchema,
  oauthStartUrl,
} from "@/lib/credentials";
import { connectErrorText } from "@/lib/google-oauth";
import { Badge, ButtonAnchor, ButtonLink, Card, PageTitle } from "@/components/ds";
import { disconnectAccount } from "@/server/account-actions";
import { ConnectPanel, type Connectable } from "./connect-panel";
import {
  connectorStartUrl,
  editorsWithoutGrant,
  listProviders,
  missingSettings,
} from "@/lib/connectors/providers";
import { TelegramLinkCard } from "./telegram-link-card";
import { ConnectorsTabs, DiscoverView } from "./discover-view";
import { telegramLinkFor } from "@/server/channel-links";
import { env } from "@/lib/env";

export const metadata = { title: "Connectors · Builder" };

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
  googleDriveOAuth2Api: {
    grants: [
      "Read the folders you choose to index",
      "Create files, and read and edit the Sheets, Docs and Slides you work with",
    ],
    denies: ["Reads only the folders you choose to index"],
  },
  googleSheetsOAuth2Api: {
    grants: ["Read and write the sheets you name"],
    denies: ["No access to the rest of your Drive"],
  },
  asanaOAuth2Api: {
    grants: ["Read and update the Asana work your account can already reach"],
    denies: ["Nothing beyond what your Asana account is allowed to do"],
  },
  openAiApi: {
    grants: ["Send prompts on your behalf"],
    denies: ["No access to your account settings"],
  },
};

const CONNECTABLE: { credentialType: string; displayName: string }[] = [
  { credentialType: "facebookGraphApi", displayName: "Facebook & Instagram" },
  { credentialType: "slackApi", displayName: "Slack" },
  { credentialType: "hubspotApi", displayName: "HubSpot" },
  { credentialType: "openAiApi", displayName: "AI model" },
  { credentialType: GOOGLE_DRIVE_CREDENTIAL, displayName: "Google Suite" },
];

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{
    connect?: string;
    connected?: string;
    connect_error?: string;
    tab?: string;
    q?: string;
  }>;
}) {
  const {
    connect,
    connected: justConnected,
    connect_error: connectError,
    tab,
    q,
  } = await searchParams;
  const user = await requireUser();

  const accounts = await prisma.connector.findMany({
    where: { userId: user.id, status: { not: "REVOKED" } },
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

  // Tools signed into through the generic connector sign-in, offered only once their
  // app is configured on the server: a button that cannot work is worse than none.
  const connectorOptions: Connectable[] = listProviders()
    .filter((provider) => missingSettings(provider).length === 0)
    .map((provider) => ({
      credentialType: provider.credentialType,
      displayName: provider.displayName,
      allows: ALLOWS[provider.credentialType] ?? { grants: [], denies: [] },
      oauthStartUrl: connectorStartUrl(provider),
      oauthLabel: provider.displayName,
      fields: [],
    }));

  if (tab === "discover") {
    // Discover needs only what is connectable today, not the n8n schemas Yours reads.
    const available = new Set([
      ...CONNECTABLE.map((item) => item.credentialType),
      ...connectorOptions.map((option) => option.credentialType),
    ]);
    const connectedTypes = new Set(
      accounts.filter((a) => a.status === "ACTIVE").map((a) => a.credentialType),
    );
    return (
      <div className="px-5 py-5 lg:px-7">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <PageTitle title="Connectors" />
          <ConnectorsTabs active="discover" />
        </div>
        <DiscoverView q={q ?? ""} available={available} connectedTypes={connectedTypes} />
      </div>
    );
  }

  const connectable: Connectable[] = [
    ...(await Promise.all(
    CONNECTABLE.map(async (item) => {
      const oauthStartHref =
        item.credentialType === GOOGLE_DRIVE_CREDENTIAL ? oauthStartUrl("/accounts") : undefined;
      // The same order as the setup wizard: what is known to be right first, then n8n's own answer.
      const schema = oauthStartHref
        ? null
        : (knownCredentialSchema(item.credentialType) ??
          (await n8n.credentialSchema(item.credentialType)));
      return {
        credentialType: item.credentialType,
        displayName: item.displayName,
        allows: ALLOWS[item.credentialType] ?? { grants: [], denies: [] },
        oauthStartUrl: oauthStartHref,
        oauthLabel: oauthStartHref ? "Google" : undefined,
        // Facebook has both: the sign-in, and a pasted access token as the second way.
        signInUrl: hasFacebookSignIn(item.credentialType)
          ? oauthStartUrl("/accounts", item.credentialType)
          : undefined,
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
    )),
    ...connectorOptions,
  ];

  const telegram = await telegramLinkFor(user.id);

  // Read on the server only: what leaves it is the names of the editors to reconnect for.
  const driveSecrets = await prisma.connector.findMany({
    where: { userId: user.id, credentialType: GOOGLE_DRIVE_CREDENTIAL, status: "ACTIVE" },
    select: { id: true, secretJson: true },
  });
  const reconnectFor = new Map<string, string[]>();
  for (const drive of driveSecrets) {
    const names = editorsWithoutGrant(drive.secretJson);
    if (names.length > 0) reconnectFor.set(drive.id, names);
  }

  const connected = accounts.filter((a) => a.status !== "PENDING").length;

  return (
    <div className="px-5 py-5 lg:px-7">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <PageTitle title="Connectors" meta={`· ${connected} connected`} />
        <ConnectorsTabs active="yours" />
      </div>

      {connectError ? (
        <p role="alert" className="mt-3 text-[13px] text-danger-ink">
          {connectErrorText(connectError)}
        </p>
      ) : justConnected ? (
        <p role="status" className="mt-3 text-[13px] text-ready-ink">
          Connected.
        </p>
      ) : null}

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
                  {reconnectFor.has(account.id) ? (
                    <div className="mt-0.5 text-xs text-danger-ink">
                      Reconnect to allow {reconnectFor.get(account.id)!.join(", ")}.
                    </div>
                  ) : null}
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
                  account.credentialType === GOOGLE_DRIVE_CREDENTIAL ||
                  hasFacebookSignIn(account.credentialType) ? (
                    <ButtonAnchor
                      href={oauthStartUrl("/accounts", account.credentialType)}
                      size="sm"
                    >
                      Reconnect
                    </ButtonAnchor>
                  ) : (
                    <ButtonLink
                      href={`/accounts?connect=${account.credentialType}`}
                      size="sm"
                    >
                      Reconnect
                    </ButtonLink>
                  )
                ) : account.scope === "PLATFORM" ? (
                  <Badge tone="platform">Platform</Badge>
                ) : account.status === "PENDING" ? (
                  // The button that does the connecting is on the row itself, not only in
                  // the "Connect an account" panel further down.
                  account.credentialType === GOOGLE_DRIVE_CREDENTIAL ||
                  hasFacebookSignIn(account.credentialType) ? (
                    <ButtonAnchor
                      href={oauthStartUrl("/accounts", account.credentialType)}
                      size="sm"
                    >
                      Connect
                    </ButtonAnchor>
                  ) : (
                    <ButtonLink href={`/accounts?connect=${account.credentialType}`} size="sm">
                      Connect
                    </ButtonLink>
                  )
                ) : (
                  <>
                    <Badge tone="ready">Active</Badge>
                    {reconnectFor.has(account.id) ? (
                      <ButtonAnchor href={oauthStartUrl("/accounts", account.credentialType)} size="sm">
                        Reconnect
                      </ButtonAnchor>
                    ) : null}
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

        <div className="flex flex-col gap-4">
          <ConnectPanel options={connectable} preselect={connect} />
          <TelegramLinkCard
            linkedAt={telegram?.linkedAt.toISOString() ?? null}
            botUsername={env.telegramBotUsername}
          />
        </div>
      </div>
    </div>
  );
}
