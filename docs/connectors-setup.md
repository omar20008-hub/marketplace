# Connectors: what has to be set up before they work

A connector is a tool a person connects from **Connectors** (Discover → Connect).
Each sign-in tool needs an app registered with the tool itself, two values from
that registration in the deployment's environment, and one redirect URI registered
exactly as shown below. Without those, the button is hidden (see
`missingSettings` in `src/lib/connectors/providers.ts`), so a missing value shows
as an absent button rather than an error.

Nothing here changes the database. Apply the pending migrations as usual (see
`CLAUDE.md`): the revoke feature needs `20261012090000_connector_revoked`, and that
one has not been applied to production yet.

## The redirect URI

Every sign-in tool returns to this app at:

    <PUBLIC_URL>/api/connectors/<tool>/callback

`PUBLIC_URL` is the app's public origin, for example `https://app.example.com`. Set
it in Railway. It must match what is registered with each tool, scheme and host
included, with no trailing slash.

| Tool | `<tool>` in the URL | Registered where |
|---|---|---|
| Asana | `asana` | Asana developer console → My apps |
| Notion | `notion` | notion.so/my-integrations → Public integration |
| Airtable | `airtable` | airtable.com/create/oauth → OAuth integration |
| Trello | (none, see below) | trello.com/power-ups/admin → your Power-Up |
| Microsoft 365 | `microsoft365` | Microsoft Entra admin center → App registrations |
| Stripe | `stripe` | Stripe Dashboard → Connect → Settings |

Google Suite and Facebook keep their own, existing callbacks:
`<PUBLIC_URL>/api/oauth/google/callback` (Drive) and `<PUBLIC_URL>/api/oauth/google/auth/callback`
(sign-in), and `<PUBLIC_URL>/api/oauth/facebook/callback`. `.env.example` lists them.

## Per tool

### Asana
- Create an app in the Asana developer console. Add the redirect URI above.
- Environment: `ASANA_CLIENT_ID`, `ASANA_CLIENT_SECRET`.

### Notion
- Create a **Public** integration at notion.so/my-integrations. Enable the read,
  update and insert content capabilities.
- Add the redirect URI. Notion asks for the owner on consent (`owner=user` is set).
- Environment: `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`.
- Notion grants access to the pages the person selects on the consent screen, not
  to the whole workspace. Say so to people who ask.

### Airtable
- Create an OAuth integration at airtable.com/create/oauth. Add the redirect URI.
- Scopes the app asks for: `data.records:read`, `data.records:write`,
  `schema.bases:read`. Add `user.email:read` in the integration if you want the
  account's email as its label (without it the label is the Airtable user id).
- PKCE is on. Airtable requires it for this flow.
- Environment: `AIRTABLE_CLIENT_ID`, `AIRTABLE_CLIENT_SECRET`.

### Trello
- Create a Power-Up at trello.com/power-ups/admin, then generate its API key and
  secret on the API key tab.
- Trello takes the callback in each request, so there is no redirect URI to
  register on the Power-Up. Check the Power-Up's allowed origins if Trello refuses
  the approval page.
- Environment: `TRELLO_API_KEY` (the API key), `TRELLO_API_SECRET` (the secret).
- Approval is requested with `expiration=never`, so the grant does not lapse after
  30 days. A person can still revoke it from Trello.

### Microsoft 365
- Register an app in the Microsoft Entra admin center → App registrations.
  Supported account types: **accounts in any organizational directory and personal
  Microsoft accounts** (this matches the `common` endpoint the code uses).
- Platform: **Web**. Add the redirect URI above.
- Certificates & secrets → New client secret. Note its expiry date: when it lapses,
  every Microsoft connection stops working until the secret is replaced.
- API permissions (Microsoft Graph, delegated): `offline_access`, `User.Read`,
  `Files.ReadWrite.All`, `Sites.ReadWrite.All`. Some organizations need an
  administrator to grant consent for the last two.
- Environment: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`.

### Stripe (Connect, Standard accounts)
- In the Stripe Dashboard, open Connect → Settings → Integration. Enable OAuth for
  Standard accounts and add the redirect URI above.
- Environment: `STRIPE_CONNECT_CLIENT_ID` (the `ca_…` id), and `STRIPE_SECRET_KEY`.
  The secret key must be from the same mode as the Connect client id: a live
  `sk_live_…` with a live `ca_…`, or the test pair for both. A mismatch fails at the
  token step with `tool_token`.
- The person connects their own Stripe account. The platform never receives their
  secret key.

## After deploying: check each tool once

For each tool, signed in as an ordinary user:

1. Open **Connectors** → **Discover**, and choose the tool's Connect button.
2. The tool's own sign-in or approval page should open. If you land on
   **Connectors** with a message instead, read the code below.
3. Approve. You should return to **My connections** with the tool listed.

If it fails, the server log has a line `<Tool> sign-in failed: <code>`, and the
page shows the matching message:

| Code | Meaning | What to check |
|---|---|---|
| `tool_not_configured` | The client id or secret is empty | The environment variables, and a redeploy after setting them |
| `tool_state` | The sign-in link expired or was opened in another browser | Start again from Connectors |
| `tool_denied` | The person declined on the tool's page | Nothing to fix |
| `tool_token` | The tool refused the code (wrong secret, redirect URI mismatch, wrong Stripe mode) | The registered redirect URI and the secret |
| `tool_identity` | The tool would not say who the person is | The scopes (Airtable's email, Microsoft's `User.Read`) |
| `tool_failed` | Anything else | The server log |

## Not covered here

- **Slack and HubSpot** still connect with a pasted key only; the templates that
  use them take the key in n8n. Sign-in for them waits on a decision about the
  templates.
- **OpenAI** has no sign-in for third-party apps; it stays a pasted key.
- **Telegram** connects through its bot's link, not sign-in.
- **Tools that need an address of their own** (Salesforce, Shopify, Zendesk,
  ServiceNow, Odoo, Xero, QuickBooks, Jira) are not added yet.
- The sign-in code has not been run against the live services. The first real
  sign-in for each tool is the test that counts.
