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
