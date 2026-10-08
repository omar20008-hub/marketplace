import type { CredentialSchema } from "@/lib/n8n/contracts";

/**
 * n8n's own GET /credentials/schema/:type is not trustworthy for every
 * credential type a community node package defines. For googlePalmApi it
 * has been seen both answering nothing at all, and answering with only
 * "apiKey" — while n8n's own POST /credentials (the endpoint that actually
 * creates the credential) rejects a googlePalmApi body missing "host"
 * outright ("request.body.data requires property \"host\""), confirmed
 * against a real 400 from Create User Credentials in MP · Install Template.
 * The UI form treats "host" as optional with a default; the create API does
 * not honour that default on a missing key, it just rejects the request.
 *
 * KNOWN_SCHEMAS is ground truth for types this has already burned us on, and
 * wins over whatever the live endpoint says, right or wrong. For everything
 * else, a non-OAuth n8n credential type is, underneath, usually a single
 * secret field named "apiKey" (openAiApi, hubspotApi, slackApi, …), so that
 * is the fallback the setup wizard uses instead of telling the user there is
 * no way to connect at all — only when the live endpoint has nothing.
 */
export function isOAuthCredential(credentialType: string) {
  return /oauth/i.test(credentialType);
}

export const GOOGLE_DRIVE_CREDENTIAL = "googleDriveOAuth2Api";

/**
 * OAuth types the platform connects and holds itself. Their tokens never go to
 * n8n and are never typed into a form — only the sign-in flow may create one.
 */
export function isPlatformOAuth(credentialType: string) {
  return credentialType === GOOGLE_DRIVE_CREDENTIAL;
}

export const FACEBOOK_CREDENTIAL = "facebookGraphApi";

/**
 * Facebook is the other kind: the user signs in on Facebook and the platform
 * keeps the token it gets back — but the token is still written into n8n's
 * credential at install like a pasted one, so a Facebook connection stays an
 * ordinary connection and pasting an access token remains a second way to make it.
 */
export function hasFacebookSignIn(credentialType: string) {
  return credentialType === FACEBOOK_CREDENTIAL;
}

/** The link that starts that sign-in, and where it should land the user after. */
export function oauthStartUrl(returnTo: string, credentialType: string = GOOGLE_DRIVE_CREDENTIAL) {
  const provider = hasFacebookSignIn(credentialType) ? "facebook" : "google";
  return `/api/oauth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`;
}

const genericSecretSchema: CredentialSchema = {
  type: "object",
  required: ["apiKey"],
  properties: {
    apiKey: { type: "string", title: "API key", format: "password" },
  },
};

const KNOWN_SCHEMAS: Record<string, CredentialSchema> = {
  // n8n's GET /credentials/schema/facebookGraphApi answers nothing here, so the form
  // fell back to the generic "apiKey" field, and n8n's POST /credentials then refused
  // the body: `request.body.data is not allowed to have the additional property
  // "apiKey"` (the credential's one field is accessToken). Seen on a live activation.
  facebookGraphApi: {
    type: "object",
    required: ["accessToken"],
    properties: {
      accessToken: {
        type: "string",
        title: "Access token",
        format: "password",
        description:
          "A long-lived user access token for the Facebook Page (and its linked Instagram Business account).",
      },
    },
  },
  googlePalmApi: {
    type: "object",
    required: ["apiKey", "host"],
    properties: {
      apiKey: { type: "string", title: "API key", format: "password" },
      host: {
        type: "string",
        title: "Host",
        default: "https://generativelanguage.googleapis.com",
      },
    },
  },
};

/** Ground-truthed schema for a type, when the live endpoint can't be trusted for it. */
export function knownCredentialSchema(credentialType: string): CredentialSchema | null {
  return KNOWN_SCHEMAS[credentialType] ?? null;
}

/** Used only when the live endpoint answers with nothing at all. */
export function fallbackCredentialSchema(credentialType: string): CredentialSchema | null {
  if (isOAuthCredential(credentialType)) return null;
  return KNOWN_SCHEMAS[credentialType] ?? genericSecretSchema;
}

/**
 * Human label for an n8n credential type, shared by every place that turns
 * a raw credentialType (e.g. "googlePalmApi") into something a user reads —
 * the setup wizard's "still needs connecting" note and the Review requirement
 * rows created at approval time.
 */
export function credentialLabel(credentialType: string) {
  const labels: Record<string, string> = {
    googleSheetsOAuth2Api: "Google Sheets",
    googleDriveOAuth2Api: "Google Drive",
    // One Facebook access token serves Pages and the Instagram Business account linked
    // to them, and more than one product uses it, so the label names the connection
    // rather than whichever product it was first written for.
    facebookGraphApi: "Facebook & Instagram",
    slackApi: "Slack",
    microsoftTeamsOAuth2Api: "Microsoft Teams",
    hubspotApi: "HubSpot",
    openAiApi: "OpenAI",
    googlePalmApi: "Google Gemini",
  };
  return labels[credentialType] ?? credentialType;
}
