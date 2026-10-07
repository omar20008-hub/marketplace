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

/** The link that starts that sign-in, and where it should land the user after. */
export function oauthStartUrl(returnTo: string) {
  return `/api/oauth/google/start?returnTo=${encodeURIComponent(returnTo)}`;
}

const genericSecretSchema: CredentialSchema = {
  type: "object",
  required: ["apiKey"],
  properties: {
    apiKey: { type: "string", title: "API key", format: "password" },
  },
};

const KNOWN_SCHEMAS: Record<string, CredentialSchema> = {
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
