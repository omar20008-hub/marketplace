import type { CredentialSchema } from "@/lib/n8n/contracts";

/**
 * n8n's own GET /credentials/schema/:type does not answer for every
 * credential type a community node package defines — a langchain model
 * credential such as googlePalmApi has been seen coming back empty even
 * though the type itself works fine once a credential of it exists. Most
 * non-OAuth n8n credential types are, underneath, a single secret field
 * named "apiKey" (openAiApi, hubspotApi, slackApi, …), so that is the
 * default fallback the setup wizard uses instead of telling the user there
 * is no way to connect at all. Same durability heuristic Install Template's
 * own Plan Credentials step already uses.
 *
 * googlePalmApi needs its own entry: n8n's POST /credentials rejects a
 * googlePalmApi body missing "host" outright ("request.body.data requires
 * property \"host\"") even though the UI form treats it as optional with a
 * default — confirmed against a real 400 from Create User Credentials in
 * MP · Install Template. The default here fills the field automatically so
 * the user only has to supply their key.
 */
export function isOAuthCredential(credentialType: string) {
  return /oauth/i.test(credentialType);
}

const genericSecretSchema: CredentialSchema = {
  type: "object",
  required: ["apiKey"],
  properties: {
    apiKey: { type: "string", title: "API key", format: "password" },
  },
};

const FALLBACK_SCHEMAS: Record<string, CredentialSchema> = {
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

export function fallbackCredentialSchema(credentialType: string): CredentialSchema | null {
  if (isOAuthCredential(credentialType)) return null;
  return FALLBACK_SCHEMAS[credentialType] ?? genericSecretSchema;
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
    facebookGraphApi: "Instagram Business",
    slackApi: "Slack",
    microsoftTeamsOAuth2Api: "Microsoft Teams",
    hubspotApi: "HubSpot",
    openAiApi: "OpenAI",
    googlePalmApi: "Google Gemini",
  };
  return labels[credentialType] ?? credentialType;
}
