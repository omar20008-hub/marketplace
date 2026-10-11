import "server-only";
import { env } from "@/lib/env";
import { GOOGLE_DRIVE_CREDENTIAL } from "@/lib/credentials";

/**
 * The tools the platform connects to, and how each one authenticates. Adding one
 * is data, not code: its endpoints, scopes, and how to read who the person is.
 *
 * The platform keeps every token and gives one to a workflow when it runs, through
 * the connector token endpoint. Nothing here is sent to n8n.
 *
 * Two kinds. A sign-in provider is a tool a person connects from Connected
 * accounts, with a redirect to the tool's own sign-in. A shared provider has no
 * sign-in of its own: it reaches the tool through another connection, such as
 * Sheets through the Google Drive connection, which holds the grant for all of
 * Google's editors.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

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
  /** The provider whose connection this one uses, when it has no connection of its own. */
  sourceCredentialType?: string;
  /** Whether the person connects this tool from Connected accounts. */
  signIn: boolean;
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
  signIn: true,
};

/** The Google connection itself, held by the platform and served to workflows on request. */
const googleDrive: ConnectorProvider = {
  id: "google-drive",
  credentialType: GOOGLE_DRIVE_CREDENTIAL,
  displayName: "Google Drive",
  initials: "GD",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: GOOGLE_TOKEN_URL,
  identityUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  scopes: [],
  clientId: () => env.google.clientId,
  clientSecret: () => env.google.clientSecret,
  settingNames: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  accountFrom: (json) => {
    const email = (json as { email?: string }).email?.toLowerCase();
    return email ? { accountRef: email, label: "Google Drive" } : null;
  },
  signIn: false,
};

/** Sheets, Docs and Slides reach Google through the Drive connection's grant. */
function googleEditor(credentialType: string, displayName: string, initials: string): ConnectorProvider {
  return {
    ...googleDrive,
    id: credentialType,
    credentialType,
    displayName,
    initials,
    sourceCredentialType: GOOGLE_DRIVE_CREDENTIAL,
    signIn: false,
  };
}

const SIGN_IN: ConnectorProvider[] = [asana];
const ALL: ConnectorProvider[] = [
  ...SIGN_IN,
  googleDrive,
  googleEditor("googleSheetsOAuth2Api", "Google Sheets", "GS"),
  googleEditor("googleDocsOAuth2Api", "Google Docs", "GD"),
  googleEditor("googleSlidesOAuth2Api", "Google Slides", "GP"),
];

/** A tool a person can connect from Connected accounts, by its URL segment. */
export function findProvider(id: string): ConnectorProvider | null {
  return SIGN_IN.find((p) => p.id === id) ?? null;
}

/** Any provider the platform holds a connection for, by the type it is stored under. */
export function findProviderByCredentialType(credentialType: string): ConnectorProvider | null {
  return ALL.find((p) => p.credentialType === credentialType) ?? null;
}

export function listProviders(): ConnectorProvider[] {
  return SIGN_IN;
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
