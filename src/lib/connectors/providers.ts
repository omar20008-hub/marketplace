import "server-only";
import { env } from "@/lib/env";

/**
 * The tools a person can sign into from the platform. Adding one is data, not
 * code: the endpoints, the scopes, and how to read who the person is.
 *
 * Only providers whose vendor issues a sign-in redirect to a registered app
 * belong here. A tool without one (Odoo's per-instance logins, Telegram's bot
 * tokens) needs its own connect path, not an entry.
 */

export type ConnectorProvider = {
  /** The URL segment: /api/connectors/<id>/... */
  id: string;
  /** The Connector.credentialType this provider's connections are stored under. */
  credentialType: string;
  displayName: string;
  initials: string;
  authorizeUrl: string;
  tokenUrl: string;
  identityUrl: string;
  scopes: string[];
  clientId: () => string;
  clientSecret: () => string;
  /** The environment names behind clientId and clientSecret, for the not-configured message. */
  settingNames: [clientId: string, clientSecret: string];
  /** Reads the account the person signed in as from the identity endpoint's answer. */
  accountFrom: (json: unknown) => { accountRef: string; label: string } | null;
};

const asana: ConnectorProvider = {
  id: "asana",
  credentialType: "asanaOAuth2Api",
  displayName: "Asana",
  initials: "AS",
  authorizeUrl: "https://app.asana.com/-/oauth_authorize",
  tokenUrl: "https://app.asana.com/-/oauth_token",
  identityUrl: "https://app.asana.com/api/1.0/users/me?opt_fields=email,name",
  scopes: [],
  clientId: () => env.asana.clientId,
  clientSecret: () => env.asana.clientSecret,
  settingNames: ["ASANA_CLIENT_ID", "ASANA_CLIENT_SECRET"],
  accountFrom: (json) => {
    const data = (json as { data?: { email?: string; name?: string; gid?: string } }).data;
    const accountRef = (data?.email ?? data?.gid ?? "").toLowerCase();
    if (!accountRef) return null;
    return { accountRef, label: data?.name ? `${data.name} (Asana)` : "Asana" };
  },
};

const PROVIDERS: Record<string, ConnectorProvider> = { [asana.id]: asana };

export function findProvider(id: string): ConnectorProvider | null {
  return Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
}

export function findProviderByCredentialType(credentialType: string): ConnectorProvider | null {
  return Object.values(PROVIDERS).find((p) => p.credentialType === credentialType) ?? null;
}

export function listProviders(): ConnectorProvider[] {
  return Object.values(PROVIDERS);
}

export function connectorStartUrl(provider: ConnectorProvider, returnTo = "/accounts"): string {
  return `/api/connectors/${provider.id}/start?returnTo=${encodeURIComponent(returnTo)}`;
}

export function missingSettings(provider: ConnectorProvider): string[] {
  const missing: string[] = [];
  if (!provider.clientId()) missing.push(provider.settingNames[0]);
  if (!provider.clientSecret()) missing.push(provider.settingNames[1]);
  return missing;
}
