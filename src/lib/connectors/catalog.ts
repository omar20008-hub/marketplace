/**
 * Every tool the Discover tab lists. An entry with a credentialType is one the
 * platform can connect (it appears in the Connect panel, or is a sign-in); an
 * entry without one is listed as coming soon. This is only the listing: what a
 * tool can do is decided by its provider, not here.
 */

export type CatalogEntry = {
  name: string;
  by: string;
  description: string;
  /** Shown in place of the logo when the tool has no logo in BRAND_ICONS. */
  initials: string;
  /** The key into BRAND_ICONS for this tool's logo, when there is one. */
  slug?: string;
  /** The credentialType the platform connects this tool under, once it can. */
  credentialType?: string;
  /** Where the tool is set up, when it is not connected through the panel. */
  href?: string;
};

export const CATALOG: CatalogEntry[] = [
  {
    name: "Google Suite",
    by: "Google",
    description: "Read the folders you index, and the Sheets, Docs and Slides you work with",
    initials: "GS",
    slug: "googledrive",
    credentialType: "googleDriveOAuth2Api",
  },
  {
    name: "Slack",
    by: "Slack",
    description: "Post to the channels you name",
    initials: "SL",
    credentialType: "slackApi",
  },
  {
    name: "HubSpot",
    by: "HubSpot",
    description: "Read and update the records a product touches",
    initials: "HS",
    slug: "hubspot",
    credentialType: "hubspotApi",
  },
  {
    name: "Facebook & Instagram",
    by: "Meta",
    description: "Publish posts and read their insights",
    initials: "FB",
    slug: "meta",
    credentialType: "facebookGraphApi",
  },
  {
    name: "AI model",
    by: "OpenAI",
    description: "Send prompts on your behalf",
    initials: "AI",
    credentialType: "openAiApi",
  },
  {
    name: "Asana",
    by: "Asana",
    description: "Read and update the work your account can already reach",
    initials: "AS",
    slug: "asana",
    credentialType: "asanaOAuth2Api",
  },
  {
    name: "Telegram",
    by: "Telegram",
    description: "Talk to the platform through its bot",
    initials: "TG",
    slug: "telegram",
    href: "/accounts",
  },
  { name: "Gmail", by: "Google", description: "Read and draft email", initials: "GM", slug: "gmail" },
  { name: "Google Calendar", by: "Google", description: "Manage events and meetings", initials: "GC", slug: "googlecalendar" },
  { name: "Microsoft 365", by: "Microsoft", description: "SharePoint, OneDrive, Outlook and Teams", initials: "MS" },
  { name: "WhatsApp", by: "Meta", description: "Send and receive business messages", initials: "WA", slug: "whatsapp" },
  { name: "Notion", by: "Notion", description: "Search and update pages and databases", initials: "NO", slug: "notion" },
  { name: "Airtable", by: "Airtable", description: "Read and update bases and records", initials: "AT", slug: "airtable" },
  { name: "Dropbox", by: "Dropbox", description: "Read and upload files", initials: "DB", slug: "dropbox" },
  { name: "Salesforce", by: "Salesforce", description: "Read and update CRM records", initials: "SF" },
  { name: "Odoo", by: "Odoo", description: "Read and update business records", initials: "OD", slug: "odoo" },
  { name: "ServiceNow", by: "ServiceNow", description: "Read and update IT service tickets", initials: "SN" },
  { name: "Trello", by: "Atlassian", description: "Read and update boards and cards", initials: "TR", slug: "trello" },
  { name: "Jira", by: "Atlassian", description: "Read and update issues", initials: "JI", slug: "jira" },
  { name: "Monday.com", by: "Monday.com", description: "Read and update boards and items", initials: "MO" },
  { name: "ClickUp", by: "ClickUp", description: "Read and update tasks", initials: "CU", slug: "clickup" },
  { name: "Shopify", by: "Shopify", description: "Orders, products and customers", initials: "SH", slug: "shopify" },
  { name: "Stripe", by: "Stripe", description: "Payments, invoices and customers", initials: "ST", slug: "stripe" },
  { name: "QuickBooks", by: "Intuit", description: "Invoices, bills and accounts", initials: "QB", slug: "quickbooks" },
  { name: "Xero", by: "Xero", description: "Invoices, bills and accounts", initials: "XE", slug: "xero" },
  { name: "Mailchimp", by: "Intuit", description: "Audiences and campaigns", initials: "MC", slug: "mailchimp" },
  { name: "Brevo", by: "Brevo", description: "Contacts and email campaigns", initials: "BR", slug: "brevo" },
  { name: "Zendesk", by: "Zendesk", description: "Support tickets and customers", initials: "ZD", slug: "zendesk" },
  { name: "Intercom", by: "Intercom", description: "Conversations and contacts", initials: "IC", slug: "intercom" },
  { name: "Pipedrive", by: "Pipedrive", description: "Deals, contacts and activities", initials: "PD" },
  { name: "Zoho", by: "Zoho", description: "CRM and business records", initials: "ZO", slug: "zoho" },
  { name: "Calendly", by: "Calendly", description: "Scheduling links and bookings", initials: "CA", slug: "calendly" },
];

/** The logo for a connection of this credentialType, if the catalog has one. */
export function slugForCredentialType(credentialType: string): string | undefined {
  return CATALOG.find((entry) => entry.credentialType === credentialType)?.slug;
}
