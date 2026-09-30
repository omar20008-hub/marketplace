import type { CredentialSchema } from "@/lib/n8n/contracts";

/**
 * n8n's own GET /credentials/schema/:type does not answer for every
 * credential type a community node package defines — a langchain model
 * credential such as googlePalmApi has been seen coming back empty even
 * though the type itself works fine once a credential of it exists. Every
 * non-OAuth n8n credential type the platform deals with is, underneath,
 * a single secret field named "apiKey" (openAiApi, hubspotApi, slackApi,
 * googlePalmApi, …), so this is what the setup wizard falls back to instead
 * of telling the user there is no way to connect at all. Same durability
 * heuristic Install Template's own Plan Credentials step already uses.
 */
export function isOAuthCredential(credentialType: string) {
  return /oauth/i.test(credentialType);
}

export const genericSecretSchema: CredentialSchema = {
  type: "object",
  required: ["apiKey"],
  properties: {
    apiKey: { type: "string", title: "API key", format: "password" },
  },
};

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
