import "server-only";
import { env } from "@/lib/env";
import { GOOGLE_DRIVE_CREDENTIAL } from "@/lib/credentials";
import { DOCS_SCOPE, SHEETS_SCOPE, SLIDES_SCOPE } from "@/lib/google-oauth";
import { openCredential } from "@/lib/secrets";

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
  /** Asks the tool who the person is. Not needed when identityFromToken reads it from the token answer. */
  identityUrl?: string;
  scopes: string[];
  /** Where the client id and secret go on a token request. The body is the default. */
  tokenAuth?: "body" | "basic";
  /** Form-encoded is the default; a few tools want JSON. */
  tokenBody?: "form" | "json";
  /** Stripe's token request takes only the secret, so the client id is left out of it. */
  omitClientIdOnToken?: boolean;
  /** Sends a PKCE challenge on authorize and the verifier on the token request. */
  pkce?: boolean;
  /** For tools that return the person inside the token answer, rather than at an identity endpoint. */
  identityFromToken?: (json: unknown) => { accountRef: string; label: string } | null;
  /** OAuth 1.0a (Trello): the endpoints for the request and access tokens. */
  oauth1?: { requestTokenUrl: string; accessTokenUrl: string; scope: string };
  clientId: () => string;
  clientSecret: () => string;
  /** The environment names behind clientId and clientSecret, for the not-configured message. */
  settingNames: [clientId: string, clientSecret: string];
  /** Reads the account the person signed in as from the identity endpoint's answer. */
  accountFrom: (json: unknown) => { accountRef: string; label: string } | null;
  /** The provider whose connection this one uses, when it has no connection of its own. */
  sourceCredentialType?: string;
  /** The scope the source connection must have been granted for this tool to work. */
  requiredScope?: string;
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
  displayName: "Google Suite",
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
    return email ? { accountRef: email, label: "Google Suite" } : null;
  },
  signIn: false,
};

/** Sheets, Docs and Slides reach Google through the Drive connection's grant. */
function googleEditor(
  credentialType: string,
  displayName: string,
  initials: string,
  requiredScope: string,
): ConnectorProvider {
  return {
    ...googleDrive,
    id: credentialType,
    credentialType,
    displayName,
    initials,
    sourceCredentialType: GOOGLE_DRIVE_CREDENTIAL,
    requiredScope,
    signIn: false,
  };
}

/**
 * Whether the connection behind an editor was granted the scope the editor needs.
 * A connection made before the editors were added holds read access only, and
 * is treated as not connected for them until the person reconnects.
 */
export function editorIsGranted(provider: ConnectorProvider, secretJson: string | null): boolean {
  if (!provider.requiredScope) return true;
  if (!secretJson) return false;
  const granted = (openCredential(secretJson).scope ?? "").split(" ");
  return granted.includes(provider.requiredScope);
}

/**
 * Airtable's token endpoint wants the client credentials in a Basic header, and
 * the sign-in uses PKCE. Its access tokens lapse, and the refresh token renews them.
 */
const airtable: ConnectorProvider = {
  id: "airtable",
  credentialType: "airtableOAuth2Api",
  displayName: "Airtable",
  initials: "AT",
  authorizeUrl: "https://airtable.com/oauth2/v1/authorize",
  tokenUrl: "https://airtable.com/oauth2/v1/token",
  identityUrl: "https://api.airtable.com/v0/meta/whoami",
  scopes: ["data.records:read", "data.records:write", "schema.bases:read"],
  tokenAuth: "basic",
  pkce: true,
  clientId: () => env.airtable.clientId,
  clientSecret: () => env.airtable.clientSecret,
  settingNames: ["AIRTABLE_CLIENT_ID", "AIRTABLE_CLIENT_SECRET"],
  accountFrom: (json) => {
    const data = json as { id?: string; email?: string };
    const accountRef = (data.email ?? data.id ?? "").toLowerCase();
    if (!accountRef) return null;
    return { accountRef, label: data.email ? `${data.email} (Airtable)` : "Airtable" };
  },
  signIn: true,
};

/**
 * Notion answers the token request with the workspace and its owner, so there is
 * no identity call. The token does not expire. Its endpoint takes a JSON body
 * and the client credentials in a Basic header.
 */
const notion: ConnectorProvider = {
  id: "notion",
  credentialType: "notionOAuth2Api",
  displayName: "Notion",
  initials: "NO",
  authorizeUrl: "https://api.notion.com/v1/oauth/authorize?owner=user",
  tokenUrl: "https://api.notion.com/v1/oauth/token",
  scopes: [],
  tokenAuth: "basic",
  tokenBody: "json",
  clientId: () => env.notion.clientId,
  clientSecret: () => env.notion.clientSecret,
  settingNames: ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"],
  accountFrom: () => null,
  identityFromToken: (json) => {
    const data = json as {
      workspace_id?: string;
      workspace_name?: string;
      owner?: { user?: { person?: { email?: string } } };
    };
    const accountRef = (data.owner?.user?.person?.email ?? data.workspace_id ?? "").toLowerCase();
    if (!accountRef) return null;
    return { accountRef, label: `${data.workspace_name ?? "Notion"} (Notion)` };
  },
  signIn: true,
};

/**
 * Trello signs in with OAuth 1.0a: a request token, the person's approval, then
 * an access token. The app key and secret are the Power-Up's API key and secret.
 * Its tokens do not expire here (see the authorize call), so there is no refresh.
 */
const trello: ConnectorProvider = {
  id: "trello",
  credentialType: "trelloApi",
  displayName: "Trello",
  initials: "TR",
  authorizeUrl: "https://trello.com/1/OAuthAuthorizeToken",
  tokenUrl: "https://trello.com/1/OAuthGetAccessToken",
  identityUrl: "https://api.trello.com/1/members/me",
  scopes: [],
  oauth1: {
    requestTokenUrl: "https://trello.com/1/OAuthGetRequestToken",
    accessTokenUrl: "https://trello.com/1/OAuthGetAccessToken",
    scope: "read,write",
  },
  clientId: () => env.trello.clientId,
  clientSecret: () => env.trello.clientSecret,
  settingNames: ["TRELLO_API_KEY", "TRELLO_API_SECRET"],
  accountFrom: (json) => {
    const data = json as { username?: string; fullName?: string; id?: string };
    const accountRef = (data.username ?? data.id ?? "").toLowerCase();
    if (!accountRef) return null;
    return { accountRef, label: data.fullName ? `${data.fullName} (Trello)` : "Trello" };
  },
  signIn: true,
};

/**
 * Microsoft 365 through Microsoft's identity platform. The common endpoint takes
 * work and personal accounts. offline_access is what makes it issue a refresh
 * token. Admin consent may be needed in some work tenants.
 */
const microsoft365: ConnectorProvider = {
  id: "microsoft365",
  credentialType: "microsoftGraphOAuth2Api",
  displayName: "Microsoft 365",
  initials: "MS",
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  identityUrl: "https://graph.microsoft.com/v1.0/me",
  scopes: ["offline_access", "User.Read", "Files.ReadWrite.All", "Sites.ReadWrite.All"],
  clientId: () => env.microsoft.clientId,
  clientSecret: () => env.microsoft.clientSecret,
  settingNames: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
  accountFrom: (json) => {
    const data = json as { id?: string; mail?: string; userPrincipalName?: string; displayName?: string };
    const accountRef = (data.mail ?? data.userPrincipalName ?? data.id ?? "").toLowerCase();
    if (!accountRef) return null;
    return { accountRef, label: data.displayName ? `${data.displayName} (Microsoft 365)` : "Microsoft 365" };
  },
  signIn: true,
};

/**
 * Stripe Connect, OAuth for Standard accounts: the person connects their own
 * Stripe account. The token answer names the account (stripe_user_id), so there
 * is no identity call. The client secret is the platform's secret key.
 */
const stripe: ConnectorProvider = {
  id: "stripe",
  credentialType: "stripeConnectOAuth2Api",
  displayName: "Stripe",
  initials: "ST",
  authorizeUrl: "https://connect.stripe.com/oauth/authorize",
  tokenUrl: "https://connect.stripe.com/oauth/token",
  scopes: ["read_write"],
  omitClientIdOnToken: true,
  clientId: () => env.stripe.connectClientId,
  clientSecret: () => env.stripe.secretKey,
  settingNames: ["STRIPE_CONNECT_CLIENT_ID", "STRIPE_SECRET_KEY"],
  accountFrom: () => null,
  identityFromToken: (json) => {
    const accountId = (json as { stripe_user_id?: string }).stripe_user_id;
    if (!accountId) return null;
    return { accountRef: accountId, label: `Stripe account ${accountId}` };
  },
  signIn: true,
};

const SIGN_IN: ConnectorProvider[] = [asana, airtable, notion, trello, microsoft365, stripe];
const ALL: ConnectorProvider[] = [
  ...SIGN_IN,
  googleDrive,
  googleEditor("googleSheetsOAuth2Api", "Google Sheets", "GS", SHEETS_SCOPE),
  googleEditor("googleDocsOAuth2Api", "Google Docs", "GD", DOCS_SCOPE),
  googleEditor("googleSlidesOAuth2Api", "Google Slides", "GP", SLIDES_SCOPE),
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

/** The names of the Google editors a Drive connection does not yet have the scope for. */
export function editorsWithoutGrant(secretJson: string | null): string[] {
  return ALL.filter(
    (p) => p.sourceCredentialType === GOOGLE_DRIVE_CREDENTIAL && !editorIsGranted(p, secretJson),
  ).map((p) => p.displayName);
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
