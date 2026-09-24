import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { nextRun } from "../src/lib/cron";

/**
 * Seeds the catalogue, workspace, runs, submissions and review queue that the
 * design canvas shows, so all eleven screens have real rows behind them.
 *
 * Counts are NOT padded to match the mock copy. The marketplace header says
 * "168 results" in the design; here it says whatever is actually in the table.
 * A real number that can be wrong is worth more than a decorative one.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const DEMO_PASSWORD = "builder";

// The design's timeline is mid-September; anchor everything to it.
const d = (day: number, hour: number, minute: number) =>
  new Date(Date.UTC(2026, 8, day, hour, minute));

async function main() {
  console.log("Clearing…");
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.submissionIssue.deleteMany(),
    prisma.submission.deleteMany(),
    prisma.message.deleteMany(),
    prisma.artifact.deleteMany(),
    prisma.runStep.deleteMany(),
    prisma.run.deleteMany(),
    prisma.thread.deleteMany(),
    prisma.schedule.deleteMany(),
    prisma.installationCredential.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.connectedAccount.deleteMany(),
    prisma.review.deleteMany(),
    prisma.requirement.deleteMany(),
    prisma.productVersion.deleteMany(),
    prisma.product.deleteMany(),
    prisma.user.deleteMany(),
    prisma.plan.deleteMany(),
    prisma.storageAdapter.deleteMany(),
  ]);

  // ------------------------------------------------------------------ plans
  await prisma.plan.createMany({
    data: [
      { id: "free", name: "Free", monthlyRuns: 50, storageBytes: BigInt(1_000_000_000), monthlyCredits: 0 },
      { id: "pro", name: "Pro", monthlyRuns: 1000, storageBytes: BigInt(10_000_000_000), monthlyCredits: 1500, priceMonthly: 29 },
      { id: "team", name: "Team", monthlyRuns: 5000, storageBytes: BigInt(100_000_000_000), monthlyCredits: 8000, priceMonthly: 99 },
    ],
  });

  // ------------------------------------------------------------------ users
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const nora = await prisma.user.create({
    data: {
      email: "nora@acme.co",
      name: "Nora Haddad",
      passwordHash,
      roles: ["USER", "ADMIN"],
      orgName: "Acme Co.",
      initials: "NH",
      planId: "pro",
      credits: 1240,
      renewsAt: new Date(Date.UTC(2026, 9, 1)), // "Renews 1 Oct"
    },
  });

  const rami = await prisma.user.create({
    data: {
      email: "rami@studio.co",
      name: "Rami K.",
      passwordHash,
      roles: ["USER", "CREATOR"],
      initials: "RK",
      planId: "pro",
      credits: 300,
      creatorName: "Rami K.",
      creatorVerified: true,
      avatarTint: "#e7f6ed",
      avatarInk: "#137a45",
    },
  });

  const otherCreators = await Promise.all(
    [
      { email: "dana@lift.io", name: "Dana S.", initials: "DS", verified: true },
      { email: "omar@lab.dev", name: "Omar T.", initials: "OT", verified: true },
      { email: "karim@sync.co", name: "Karim B.", initials: "KB", verified: true },
      { email: "lina@seo.works", name: "Lina H.", initials: "LH", verified: true },
      { email: "new@creator.io", name: "new creator", initials: "NC", verified: false },
    ].map((c) =>
      prisma.user.create({
        data: {
          email: c.email,
          name: c.name,
          passwordHash,
          roles: ["USER", "CREATOR"],
          initials: c.initials,
          planId: "free",
          creatorName: c.name,
          creatorVerified: c.verified,
        },
      }),
    ),
  );
  const [dana, omar, karim, lina, newCreator] = otherCreators;

  // ------------------------------------------------------- storage adapters
  await prisma.storageAdapter.createMany({
    data: [
      { backend: "platform", displayName: "Platform storage", adapterWorkflowId: "builtin", active: true },
      { backend: "drive", displayName: "Google Drive", credentialType: "googleDriveOAuth2Api", active: false },
      { backend: "s3", displayName: "Amazon S3", credentialType: "aws", supportsPresign: true, active: false },
    ],
  });

  // -------------------------------------------------------------- catalogue
  type Spec = {
    slug: string;
    title: string;
    summary: string;
    description: string;
    needsFromYou: string;
    kind: "AGENT" | "WORKFLOW";
    category: string;
    version: string;
    status:
      | "PUBLISHED"
      | "IN_REVIEW"
      | "RESTRICTED"
      | "DRAFT"
      | "SECURITY_HOLD";
    creatorId: string;
    usesCredits?: boolean;
    ratingAvg?: number;
    ratingCount?: number;
    runsLast30d?: number;
    healthPct?: number;
    featured?: boolean;
    trending?: boolean;
    actionType?: "READ" | "WRITE";
    requiredCredentials?: string[];
    externalHosts?: string[];
    flaggedNodes?: string[];
    restrictionNote?: string;
    inputSchema?: { name: string; label: string; type: string; required?: boolean; note?: string }[];
    outputs?: { name: string; note: string }[];
  };

  const specs: Spec[] = [
    {
      slug: "weekly-sales-digest",
      title: "Weekly Sales Digest",
      summary: "Summarises the week's sales and posts it to a channel every Sunday.",
      description: "Reads the week's closed deals, writes a short digest and posts it to the channel you choose.",
      needsFromYou: "Your Teams or Slack channel. The sales sheet can stay on the platform connection.",
      kind: "WORKFLOW",
      category: "Sales",
      version: "2.3",
      status: "PUBLISHED",
      creatorId: dana.id,
      ratingAvg: 4.6,
      ratingCount: 218,
      runsLast30d: 1200,
      healthPct: 99.1,
      featured: true,
      actionType: "WRITE",
      requiredCredentials: ["microsoftTeamsOAuth2Api", "googleSheetsOAuth2Api"],
      externalHosts: ["graph.microsoft.com", "sheets.googleapis.com"],
      inputSchema: [
        { name: "channel", label: "Channel", type: "string", required: true },
        { name: "week", label: "Week starting", type: "date", required: false },
      ],
      outputs: [{ name: "Digest", note: "text" }, { name: "Post receipt", note: "log" }],
    },
    {
      slug: "inbox-triage-agent",
      title: "Inbox Triage Agent",
      summary: "Reads new mail, decides what needs a reply, drafts one for approval.",
      description: "Goes through unread mail, sorts what needs a human, and leaves a draft reply for each one.",
      needsFromYou: "Your mailbox. Everything else is provided by the platform.",
      kind: "AGENT",
      category: "Operations",
      version: "1.7",
      status: "PUBLISHED",
      creatorId: omar.id,
      ratingAvg: 4.4,
      ratingCount: 96,
      runsLast30d: 830,
      healthPct: 97.2,
      trending: true,
      actionType: "WRITE",
      requiredCredentials: ["microsoftTeamsOAuth2Api"],
      externalHosts: ["graph.microsoft.com"],
      inputSchema: [{ name: "folder", label: "Folder", type: "string", required: true }],
      outputs: [{ name: "Triage list", note: "table" }, { name: "Draft replies", note: "text" }],
    },
    {
      slug: "lead-enrichment",
      title: "Lead Enrichment",
      summary: "Adds company size, industry and a contact to every row of a lead sheet.",
      description: "Takes a sheet of leads and fills in firmographic columns for each row.",
      needsFromYou: "Your sheet. The lookup service is provided by the platform.",
      kind: "WORKFLOW",
      category: "Sales",
      version: "1.0",
      status: "IN_REVIEW",
      creatorId: dana.id,
      ratingAvg: 4.5,
      ratingCount: 64,
      runsLast30d: 420,
      healthPct: 98.8,
      flaggedNodes: ["n8n-nodes-base.code"],
      requiredCredentials: ["googleSheetsOAuth2Api"],
      externalHosts: ["sheets.googleapis.com"],
      inputSchema: [{ name: "sheetUrl", label: "Sheet URL", type: "string", required: true }],
      outputs: [{ name: "Enriched sheet", note: "table" }],
    },
    {
      slug: "expense-report-builder",
      title: "Expense Report Builder",
      summary: "Turns a transactions sheet into a categorised, reconciled expense report.",
      description: "Pulls the quarter's transactions, categorises and reconciles them, and builds the report.",
      needsFromYou: "Nothing. Everything this needs is provided by the platform.",
      kind: "WORKFLOW",
      category: "Finance",
      version: "1.4",
      status: "PUBLISHED",
      creatorId: karim.id,
      ratingAvg: 4.3,
      ratingCount: 77,
      runsLast30d: 610,
      healthPct: 99.6,
      inputSchema: [
        { name: "quarter", label: "Quarter", type: "string", required: true },
        { name: "recipient", label: "Send to", type: "string", required: false },
      ],
      outputs: [{ name: "Expense report", note: "spreadsheet" }],
    },
    {
      slug: "instagram-publisher",
      title: "Instagram Publisher",
      summary: "Writes captions from a product page and schedules the posts.",
      description: "Reads a product page, writes captions in your brand voice, schedules the posts.",
      needsFromYou: "Your Instagram account. Everything else is provided by the platform.",
      kind: "WORKFLOW",
      category: "Marketing",
      version: "4.1",
      status: "PUBLISHED",
      creatorId: rami.id,
      ratingAvg: 4.7,
      ratingCount: 512,
      runsLast30d: 2900,
      healthPct: 98.4,
      featured: true,
      trending: true,
      actionType: "WRITE",
      requiredCredentials: ["facebookGraphApi"],
      externalHosts: ["graph.facebook.com"],
      inputSchema: [
        { name: "productUrl", label: "Product page URL", type: "string", required: true },
        { name: "count", label: "Number of captions", type: "number", required: false, note: "1–20, default 10" },
        { name: "tone", label: "Tone", type: "string", required: false, note: "optional" },
      ],
      outputs: [
        { name: "Caption set", note: "text file" },
        { name: "Schedule plan", note: "table" },
        { name: "Post confirmations", note: "log" },
      ],
    },
    {
      slug: "contract-reviewer",
      title: "Contract Reviewer",
      summary: "Flags unusual clauses in an uploaded contract and explains why.",
      description: "Reads an uploaded contract, flags clauses that differ from the norm, and explains each one.",
      needsFromYou: "Nothing, but this one spends credits because it uses a specific model.",
      kind: "AGENT",
      category: "Legal",
      version: "1.2",
      status: "PUBLISHED",
      creatorId: omar.id,
      usesCredits: true,
      ratingAvg: 4.2,
      ratingCount: 41,
      runsLast30d: 120,
      healthPct: 96.4,
      inputSchema: [{ name: "file", label: "Contract file", type: "file", required: true }],
      outputs: [{ name: "Findings", note: "document" }],
    },
    {
      slug: "invoice-chaser",
      title: "Invoice Chaser",
      summary: "Existing users only while the creator fixes a failing integration.",
      description: "Chases unpaid invoices on a schedule and logs every reply.",
      needsFromYou: "Your accounting connection.",
      kind: "WORKFLOW",
      category: "Finance",
      version: "3.0",
      status: "RESTRICTED",
      creatorId: rami.id,
      ratingAvg: 4.0,
      ratingCount: 33,
      runsLast30d: 90,
      healthPct: 71.2,
      actionType: "WRITE",
      restrictionNote: "Restricted by the platform while the creator fixes a failure. Existing runs still work.",
      requiredCredentials: ["hubspotApi"],
      externalHosts: ["api.hubapi.com"],
      inputSchema: [{ name: "olderThanDays", label: "Older than (days)", type: "number", required: true }],
      outputs: [{ name: "Chase log", note: "log" }],
    },
    {
      slug: "research-assistant",
      title: "Research Assistant",
      summary: "Answers a research question with sourced notes you can check.",
      description: "Reads across your connected sources and writes up an answer with every claim linked.",
      needsFromYou: "Nothing. The platform provides the model and file access.",
      kind: "AGENT",
      category: "Operations",
      version: "1.9",
      status: "PUBLISHED",
      creatorId: omar.id,
      ratingAvg: 4.5,
      ratingCount: 58,
      runsLast30d: 260,
      healthPct: 99.0,
      inputSchema: [{ name: "question", label: "Question", type: "string", required: true }],
      outputs: [{ name: "Notes", note: "document" }],
    },
    {
      slug: "ad-copy-generator",
      title: "Ad Copy Generator",
      summary: "Writes ad variants from one product brief.",
      description: "Takes a brief and produces ad copy variants for each placement.",
      needsFromYou: "Nothing yet — this one is still a draft.",
      kind: "WORKFLOW",
      category: "Marketing",
      version: "0.1",
      status: "DRAFT",
      creatorId: rami.id,
      inputSchema: [{ name: "brief", label: "Brief", type: "string", required: true }],
      outputs: [{ name: "Variants", note: "text" }],
    },
    {
      slug: "payroll-helper",
      title: "Payroll Helper",
      summary: "Prepares the monthly payroll sheet from time entries.",
      description: "Reads time entries and prepares the payroll sheet for approval.",
      needsFromYou: "Your HR system connection.",
      kind: "WORKFLOW",
      category: "HR",
      version: "1.0",
      status: "IN_REVIEW",
      creatorId: newCreator.id,
      flaggedNodes: ["n8n-nodes-base.postgres"],
      requiredCredentials: ["hubspotApi"],
      externalHosts: ["api.hubapi.com", "payroll.internal"],
      inputSchema: [{ name: "month", label: "Month", type: "string", required: true }],
      outputs: [{ name: "Payroll sheet", note: "table" }],
    },
    {
      slug: "seo-auditor",
      title: "SEO Auditor",
      summary: "Audits a site and ranks what to fix first.",
      description: "Crawls the pages you name, scores them, and orders the fixes by expected gain.",
      needsFromYou: "Nothing.",
      kind: "AGENT",
      category: "Content",
      version: "1.3",
      status: "IN_REVIEW",
      creatorId: lina.id,
      inputSchema: [{ name: "domain", label: "Domain", type: "string", required: true }],
      outputs: [{ name: "Audit", note: "table" }],
    },
    {
      slug: "crm-sync",
      title: "CRM Sync",
      summary: "Keeps two CRMs in step, one direction at a time.",
      description: "Copies new and changed records from one CRM to another on a schedule.",
      needsFromYou: "Both CRM connections.",
      kind: "WORKFLOW",
      category: "Sales",
      version: "2.1",
      status: "IN_REVIEW",
      creatorId: karim.id,
      actionType: "WRITE",
      requiredCredentials: ["hubspotApi"],
      externalHosts: ["api.hubapi.com"],
      inputSchema: [{ name: "direction", label: "Direction", type: "string", required: true }],
      outputs: [{ name: "Sync log", note: "log" }],
    },

    // Published, and deliberately NOT in Nora's workspace, so the marketplace
    // shows the readiness states the design is built around rather than a
    // column of "In workspace".
    {
      slug: "meeting-notes-agent",
      title: "Meeting Notes Agent",
      summary: "Turns a recording into notes, decisions and owned actions.",
      description: "Listens to a recording and writes up the decisions and who owns what.",
      needsFromYou: "Nothing. The platform provides the model and file access.",
      kind: "AGENT",
      category: "Operations",
      version: "2.2",
      status: "PUBLISHED",
      creatorId: omar.id,
      ratingAvg: 4.6,
      ratingCount: 143,
      runsLast30d: 980,
      healthPct: 99.2,
      trending: true,
      inputSchema: [{ name: "recording", label: "Recording", type: "file", required: true }],
      outputs: [{ name: "Notes", note: "document" }, { name: "Actions", note: "table" }],
    },
    {
      slug: "churn-watch",
      title: "Churn Watch",
      summary: "Spots accounts going quiet and says who to call first.",
      description: "Reads account activity, ranks who is drifting, and explains each signal.",
      needsFromYou: "Your CRM connection.",
      kind: "AGENT",
      category: "Sales",
      version: "1.5",
      status: "PUBLISHED",
      creatorId: dana.id,
      ratingAvg: 4.4,
      ratingCount: 87,
      runsLast30d: 410,
      healthPct: 97.8,
      requiredCredentials: ["hubspotApi"],
      externalHosts: ["api.hubapi.com"],
      inputSchema: [{ name: "segment", label: "Segment", type: "string", required: true }],
      outputs: [{ name: "Risk list", note: "table" }],
    },
    {
      slug: "story-scheduler",
      title: "Story Scheduler",
      summary: "Plans a week of stories and queues them for approval.",
      description: "Builds a week of story posts from your assets and queues each one.",
      needsFromYou: "Your Instagram account.",
      kind: "WORKFLOW",
      category: "Marketing",
      version: "1.8",
      status: "PUBLISHED",
      creatorId: rami.id,
      actionType: "WRITE",
      ratingAvg: 4.5,
      ratingCount: 201,
      runsLast30d: 1400,
      healthPct: 98.9,
      featured: true,
      requiredCredentials: ["facebookGraphApi"],
      externalHosts: ["graph.facebook.com"],
      inputSchema: [{ name: "week", label: "Week starting", type: "string", required: true }],
      outputs: [{ name: "Story plan", note: "table" }],
    },
    {
      slug: "onboarding-checklist",
      title: "Onboarding Checklist",
      summary: "Builds a first-week plan for a new joiner and tracks it.",
      description: "Creates the first-week checklist for a new joiner and follows it up.",
      needsFromYou: "Nothing.",
      kind: "WORKFLOW",
      category: "HR",
      version: "1.1",
      status: "PUBLISHED",
      creatorId: lina.id,
      ratingAvg: 4.1,
      ratingCount: 29,
      runsLast30d: 150,
      healthPct: 99.4,
      inputSchema: [{ name: "role", label: "Role", type: "string", required: true }],
      outputs: [{ name: "Checklist", note: "table" }],
    },
    {
      slug: "brief-to-blog",
      title: "Brief to Blog",
      summary: "Drafts a long post from a one-paragraph brief.",
      description: "Expands a brief into a structured draft with headings and a summary.",
      needsFromYou: "Nothing, but this one spends credits.",
      kind: "AGENT",
      category: "Content",
      version: "3.0",
      status: "PUBLISHED",
      creatorId: lina.id,
      usesCredits: true,
      ratingAvg: 4.3,
      ratingCount: 112,
      runsLast30d: 720,
      healthPct: 96.9,
      inputSchema: [{ name: "brief", label: "Brief", type: "string", required: true }],
      outputs: [{ name: "Draft", note: "document" }],
    },
    {
      slug: "reconciliation-run",
      title: "Reconciliation Run",
      summary: "Matches statements against ledger entries and lists the gaps.",
      description: "Compares a bank statement with the ledger and reports every unmatched line.",
      needsFromYou: "Your sheet.",
      kind: "WORKFLOW",
      category: "Finance",
      version: "2.0",
      status: "PUBLISHED",
      creatorId: karim.id,
      ratingAvg: 4.7,
      ratingCount: 64,
      runsLast30d: 330,
      healthPct: 99.8,
      requiredCredentials: ["googleSheetsOAuth2Api"],
      externalHosts: ["sheets.googleapis.com"],
      inputSchema: [{ name: "period", label: "Period", type: "string", required: true }],
      outputs: [{ name: "Gap report", note: "table" }],
    },
  ];

  const products: Record<string, { id: string }> = {};
  for (const spec of specs) {
    const product = await prisma.product.create({
      data: {
        slug: spec.slug,
        templateId: `tpl_${spec.slug.replace(/-/g, "").slice(0, 10)}`,
        n8nWorkflowId: `wf_${spec.slug}`,
        creatorId: spec.creatorId,
        title: spec.title,
        summary: spec.summary,
        description: spec.description,
        needsFromYou: spec.needsFromYou,
        kind: spec.kind,
        category: spec.category,
        actionType: spec.actionType ?? "READ",
        status: spec.status,
        usesCredits: spec.usesCredits ?? false,
        version: spec.version,
        nodeCount: 5 + Math.round(spec.version.length),
        inputSchema: spec.inputSchema ?? [],
        outputs: spec.outputs ?? [],
        requiredCredentials: spec.requiredCredentials ?? [],
        externalHosts: spec.externalHosts ?? [],
        flaggedNodes: spec.flaggedNodes ?? [],
        ratingAvg: spec.ratingAvg ?? 0,
        ratingCount: spec.ratingCount ?? 0,
        runsLast30d: spec.runsLast30d ?? 0,
        healthPct: spec.healthPct ?? 100,
        featured: spec.featured ?? false,
        trending: spec.trending ?? false,
        restrictionNote: spec.restrictionNote,
        platformApproved: spec.status === "PUBLISHED" || spec.status === "RESTRICTED",
        securityCheckedAt: spec.status === "PUBLISHED" ? d(12, 10, 0) : null,
        publishedAt: spec.status === "PUBLISHED" || spec.status === "RESTRICTED" ? d(12, 10, 0) : null,
      },
    });
    products[spec.slug] = product;
  }

  // Version history for the product-detail page.
  const ig = products["instagram-publisher"];
  await prisma.productVersion.createMany({
    data: [
      { productId: ig.id, version: "4.1", current: true, publishedAt: d(17, 9, 0) },
      { productId: ig.id, version: "4.0", publishedAt: new Date(Date.UTC(2026, 6, 20)) },
      { productId: ig.id, version: "3.6", deprecated: true, publishedAt: new Date(Date.UTC(2026, 3, 2)) },
    ],
  });

  // "What it needs" — one row per line of the table on the product page.
  await prisma.requirement.createMany({
    data: [
      { productId: ig.id, kind: "MODEL", label: "AI model", providedBy: "PLATFORM", sortOrder: 0 },
      { productId: ig.id, kind: "CONNECTION", label: "Google Drive", note: "— read product images", credentialType: "googleDriveOAuth2Api", providedBy: "PLATFORM_OR_OWN", sortOrder: 1 },
      { productId: ig.id, kind: "CONNECTION", label: "Instagram", note: "— publish posts", credentialType: "facebookGraphApi", providedBy: "USER", sortOrder: 2 },
      { productId: ig.id, kind: "STORAGE", label: "Results storage", note: "Platform storage (default)", providedBy: "PLATFORM", sortOrder: 3 },
    ],
  });

  // A default requirement set for everything else, so no product page is empty.
  for (const spec of specs) {
    if (spec.slug === "instagram-publisher") continue;
    const product = products[spec.slug];
    const rows: {
      productId: string;
      kind: "MODEL" | "CONNECTION" | "STORAGE";
      label: string;
      note?: string;
      credentialType?: string;
      providedBy: "PLATFORM" | "PLATFORM_OR_OWN" | "USER";
      sortOrder: number;
    }[] = [
      { productId: product.id, kind: "MODEL", label: "AI model", providedBy: "PLATFORM", sortOrder: 0 },
    ];
    (spec.requiredCredentials ?? []).forEach((credentialType, index) => {
      rows.push({
        productId: product.id,
        kind: "CONNECTION",
        label: credentialLabel(credentialType),
        credentialType,
        providedBy: credentialType.includes("google") || credentialType.includes("microsoft") ? "PLATFORM_OR_OWN" : "USER",
        sortOrder: index + 1,
      });
    });
    rows.push({
      productId: product.id,
      kind: "STORAGE",
      label: "Results storage",
      note: "Platform storage (default)",
      providedBy: "PLATFORM",
      sortOrder: 90,
    });
    await prisma.requirement.createMany({ data: rows });
  }

  // ------------------------------------------------------------- reviews
  const layla = await prisma.user.create({
    data: { email: "layla@north.co", name: "Layla M.", passwordHash, initials: "LM", planId: "free" },
  });
  const faisal = await prisma.user.create({
    data: { email: "faisal@bridge.sa", name: "Faisal A.", passwordHash, initials: "FA", planId: "free" },
  });
  await prisma.review.createMany({
    data: [
      { productId: ig.id, userId: layla.id, rating: 4, body: "Captions are solid. Scheduling needed one retry the first time.", createdAt: d(15, 12, 0) },
      { productId: ig.id, userId: faisal.id, rating: 5, body: "Set up in two minutes because the model connection was already there.", createdAt: d(11, 9, 0) },
    ],
  });

  // --------------------------------------------------- Nora's connections
  const accounts = await Promise.all(
    [
      { credentialType: "hubspotApi", displayName: "HubSpot", initials: "Hs", accountRef: "acme-crm", status: "EXPIRED" as const, scope: "OWN" as const, expiresAt: d(16, 9, 0) },
      { credentialType: "googleSheetsOAuth2Api", displayName: "Google Sheets", initials: "Sh", accountRef: "nora@acme.co", status: "ACTIVE" as const, scope: "OWN" as const },
      { credentialType: "microsoftTeamsOAuth2Api", displayName: "Microsoft Teams", initials: "Tm", accountRef: null, status: "ACTIVE" as const, scope: "PLATFORM" as const },
      { credentialType: "googleDriveOAuth2Api", displayName: "Google Drive", initials: "Dr", accountRef: null, status: "ACTIVE" as const, scope: "PLATFORM" as const },
      { credentialType: "slackApi", displayName: "Slack", initials: "Sl", accountRef: "acme.slack.com", status: "ACTIVE" as const, scope: "OWN" as const },
    ].map((a) =>
      prisma.connectedAccount.create({
        data: {
          userId: nora.id,
          credentialType: a.credentialType,
          displayName: a.displayName,
          initials: a.initials,
          accountRef: a.accountRef,
          status: a.status,
          scope: a.scope,
          expiresAt: a.expiresAt,
        },
      }),
    ),
  );
  const accountByType = new Map(accounts.map((a) => [a.credentialType, a]));

  // ------------------------------------------------------ Nora's workspace
  type Inst = {
    slug: string;
    status: "ACTIVE" | "PARTIAL" | "DISABLED";
    attentionNote?: string;
    lastRunAt?: Date;
    favourite?: boolean;
  };

  const installSpecs: Inst[] = [
    { slug: "weekly-sales-digest", status: "ACTIVE", attentionNote: "Teams access expired — Sunday's scheduled run is blocked.", lastRunAt: d(17, 18, 2) },
    { slug: "invoice-chaser", status: "ACTIVE", attentionNote: "Restricted by the platform while the creator fixes a failure. Your runs still work.", lastRunAt: d(16, 11, 30) },
    { slug: "inbox-triage-agent", status: "ACTIVE", lastRunAt: d(17, 9, 10), favourite: true },
    { slug: "contract-reviewer", status: "ACTIVE", lastRunAt: d(17, 14, 55) },
    { slug: "research-assistant", status: "ACTIVE", lastRunAt: d(14, 10, 0) },
    { slug: "expense-report-builder", status: "ACTIVE", lastRunAt: d(18, 9, 41), favourite: true },
    { slug: "instagram-publisher", status: "PARTIAL", lastRunAt: d(18, 8, 20) },
    { slug: "lead-enrichment", status: "ACTIVE", lastRunAt: d(17, 7, 0) },
  ];

  const installations: Record<string, { id: string; installationId: string | null }> = {};
  for (const spec of installSpecs) {
    const product = products[spec.slug];
    const productSpec = specs.find((s) => s.slug === spec.slug)!;
    const installation = await prisma.installation.create({
      data: {
        installationId: spec.status === "PARTIAL" ? null : `inst_${spec.slug.slice(0, 8)}`,
        userId: nora.id,
        productId: product.id,
        pinnedVersion: productSpec.version,
        instanceWorkflowId: spec.status === "PARTIAL" ? null : `u_${nora.id}_${spec.slug}`,
        status: spec.status,
        favourite: spec.favourite ?? false,
        attentionNote: spec.attentionNote,
        lastRunAt: spec.lastRunAt,
        installedAt: d(10, 8, 0),
      },
    });
    installations[spec.slug] = installation;

    for (const credentialType of productSpec.requiredCredentials ?? []) {
      const account = accountByType.get(credentialType);
      await prisma.installationCredential.create({
        data: {
          installationId: installation.id,
          credentialType,
          accountId: account?.id ?? null,
          n8nCredentialId: account ? `cred_${credentialType.slice(0, 6)}` : null,
        },
      });
    }
  }

  // ------------------------------------------------------------- schedules
  // Every scheduled product declares at least one required input, and a firing
  // has nobody to ask, so the values are stored on the schedule. Without them
  // each of these would come back "needs input" the moment the tick reached it.
  // nextRunAt is computed rather than left null so the schedules screen has a
  // real next time to show before any tick has run.
  const scheduleSpecs = [
    {
      slug: "weekly-sales-digest",
      label: "Every Sunday 18:00 UTC",
      cron: "0 18 * * 0",
      args: { channel: "#sales" },
      lastStatus: "Blocked · connection",
    },
    {
      slug: "lead-enrichment",
      label: "Every day 07:00 UTC",
      cron: "0 7 * * *",
      args: { sheetUrl: "https://docs.google.com/spreadsheets/d/seed-leads" },
      lastStatus: "Succeeded",
    },
    {
      slug: "invoice-chaser",
      label: "Weekdays 11:30 UTC",
      cron: "30 11 * * 1-5",
      args: { olderThanDays: 30 },
      lastStatus: "Failed",
    },
    {
      slug: "inbox-triage-agent",
      label: "Every hour",
      cron: "0 * * * *",
      args: { folder: "Inbox" },
      lastStatus: "Succeeded",
    },
  ];

  await prisma.schedule.createMany({
    data: scheduleSpecs.map((spec) => ({
      userId: nora.id,
      installationId: installations[spec.slug].id,
      label: spec.label,
      cron: spec.cron,
      args: spec.args,
      lastStatus: spec.lastStatus,
      nextRunAt: nextRun(spec.cron),
    })),
  });

  // ------------------------------------------------------------------ runs
  type RunSpec = {
    slug: string;
    runId: string;
    startedAt: Date;
    durationMs: number;
    result: "SUCCESS" | "PARTIAL" | "BLOCKED" | "STOPPED" | "ERROR";
    errorType?: string;
    message?: string;
    costCredits?: number;
    charged?: boolean;
    chargeNote?: string;
    steps: { label: string; status: "DONE" | "FAILED" | "SKIPPED"; durationMs?: number }[];
    artifact?: { name: string; mimeType: string; sizeBytes: number; deliveredTo?: string[] };
  };

  const runSpecs: RunSpec[] = [
    {
      slug: "expense-report-builder",
      runId: "8f2c",
      startedAt: d(18, 9, 41),
      durationMs: 72_000,
      result: "SUCCESS",
      steps: [
        { label: "Pull Q3 transactions", status: "DONE", durationMs: 6_000 },
        { label: "Categorise and reconcile", status: "DONE", durationMs: 21_000 },
        { label: "Build the report", status: "DONE", durationMs: 34_000 },
        { label: "Send to finance", status: "DONE", durationMs: 11_000 },
      ],
      artifact: { name: "Q3-Expenses.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 1_258_291, deliveredTo: ["Google Drive"] },
    },
    {
      slug: "instagram-publisher",
      runId: "5a19",
      startedAt: d(18, 8, 20),
      durationMs: 44_000,
      result: "PARTIAL",
      message: "2 of 3 posts scheduled. The third needs a reconnected account.",
      steps: [
        { label: "Read the product page", status: "DONE", durationMs: 4_000 },
        { label: "Write captions", status: "DONE", durationMs: 26_000 },
        { label: "Schedule posts", status: "FAILED", durationMs: 14_000 },
      ],
      artifact: { name: "captions-18-sep.txt", mimeType: "text/plain", sizeBytes: 4_820 },
    },
    {
      slug: "weekly-sales-digest",
      runId: "c4d0",
      startedAt: d(17, 18, 2),
      durationMs: 9_000,
      result: "BLOCKED",
      errorType: "connection",
      message: "Microsoft Teams access expired.",
      charged: false,
      chargeNote: "not charged",
      steps: [{ label: "Check connections", status: "FAILED", durationMs: 9_000 }],
    },
    {
      slug: "contract-reviewer",
      runId: "9b77",
      startedAt: d(17, 14, 55),
      durationMs: 160_000,
      result: "SUCCESS",
      costCredits: 18,
      steps: [
        { label: "Read the contract", status: "DONE", durationMs: 40_000 },
        { label: "Flag unusual clauses", status: "DONE", durationMs: 120_000 },
      ],
      artifact: { name: "Vendor-MSA-findings.pdf", mimeType: "application/pdf", sizeBytes: 320_400 },
    },
    {
      slug: "inbox-triage-agent",
      runId: "2e51",
      startedAt: d(17, 9, 10),
      durationMs: 62_000,
      result: "STOPPED",
      errorType: "step limit",
      message: "Stopped at the step limit with partial results.",
      costCredits: 6,
      steps: [
        { label: "Read unread mail", status: "DONE", durationMs: 20_000 },
        { label: "Sort by urgency", status: "DONE", durationMs: 30_000 },
        { label: "Draft replies", status: "SKIPPED", durationMs: 12_000 },
      ],
    },
    {
      slug: "invoice-chaser",
      runId: "71aa",
      startedAt: d(16, 11, 30),
      durationMs: 15_000,
      result: "ERROR",
      errorType: "integration",
      message: "The accounting service refused the request.",
      charged: false,
      chargeNote: "not charged",
      steps: [{ label: "Fetch unpaid invoices", status: "FAILED", durationMs: 15_000 }],
    },
  ];

  const runIdByHandle: Record<string, string> = {};
  for (const spec of runSpecs) {
    const installation = installations[spec.slug];
    const productSpec = specs.find((s) => s.slug === spec.slug)!;
    const run = await prisma.run.create({
      data: {
        runId: spec.runId,
        userId: nora.id,
        installationId: installation.id,
        productId: products[spec.slug].id,
        productVersion: productSpec.version,
        startedAt: spec.startedAt,
        finishedAt: new Date(spec.startedAt.getTime() + spec.durationMs),
        durationMs: spec.durationMs,
        result: spec.result,
        errorType: spec.errorType,
        message: spec.message,
        costCredits: spec.costCredits ?? 0,
        charged: spec.charged ?? true,
        chargeNote: spec.chargeNote,
      },
    });
    runIdByHandle[spec.runId] = run.id;

    await prisma.runStep.createMany({
      data: spec.steps.map((step, idx) => ({
        runId: run.id,
        idx,
        label: step.label,
        status: step.status,
        durationMs: step.durationMs,
      })),
    });

    if (spec.artifact) {
      await prisma.artifact.create({
        data: {
          runId: run.id,
          name: spec.artifact.name,
          path: `results/${spec.artifact.name}`,
          mimeType: spec.artifact.mimeType,
          sizeBytes: spec.artifact.sizeBytes,
          objectRef: `platform://${installation.installationId ?? installation.id}/results/${spec.artifact.name}`,
          deliveredTo: spec.artifact.deliveredTo ?? [],
        },
      });
    }
  }

  // --------------------------------------------------------------- threads
  const q3 = await prisma.thread.create({
    data: {
      userId: nora.id,
      title: "Q3 expense report",
      createdAt: d(18, 9, 41),
      updatedAt: d(18, 9, 42),
      messages: {
        create: [
          { role: "USER", body: "Prepare the Q3 expense report and send it to finance.", createdAt: d(18, 9, 41) },
          {
            role: "ASSISTANT",
            body: "I found a match in your workspace. It's connected and ready, so I started the run.",
            runId: runIdByHandle["8f2c"],
            createdAt: d(18, 9, 41),
          },
          {
            role: "ASSISTANT",
            body: "Done. The report is saved and a copy went to your Google Drive.",
            createdAt: d(18, 9, 42),
          },
        ],
      },
    },
  });
  await prisma.run.update({
    where: { id: runIdByHandle["8f2c"] },
    data: { threadId: q3.id },
  });

  for (const t of [
    { title: "Weekly sales digest", at: d(18, 8, 2) },
    { title: "Lead enrichment — 40 rows", at: d(17, 16, 20) },
    { title: "Instagram caption batch", at: d(17, 12, 5) },
    { title: "Contract review — Vendor MSA", at: d(17, 14, 55) },
  ]) {
    await prisma.thread.create({
      data: {
        userId: nora.id,
        title: t.title,
        createdAt: t.at,
        updatedAt: t.at,
        messages: { create: [{ role: "USER", body: t.title, createdAt: t.at }] },
      },
    });
  }

  // ----------------------------------------------- creator studio submission
  const submission = await prisma.submission.create({
    data: {
      productId: ig.id,
      creatorId: rami.id,
      version: "4.2",
      state: "VALIDATION_FAILED",
      submittedAt: d(17, 21, 4),
      checkDurationMs: 40_000,
      parsing: "PASSED",
      secrets: "FIXED",
      compatibility: "FAILED",
      security: "HUMAN_REVIEW",
      quality: "PARTIAL",
      policy: "PASSED",
      secretsRemoved: 2,
    },
  });

  await prisma.submissionIssue.createMany({
    data: [
      {
        submissionId: submission.id,
        severity: "BLOCKER",
        title: "Unsupported component: Execute Command",
        step: "Step 7 · resize images",
        detail:
          "Shell execution is not allowed on the platform. Replace it with the image resize component, or move the step out of the product.",
      },
      {
        submissionId: submission.id,
        severity: "FIXED",
        title: "2 secrets found and stripped",
        detail:
          "Steps 2 and 9 carried an API key. They are now declared as connection slots — users bring their own account. Your original file was not kept.",
      },
      {
        submissionId: submission.id,
        severity: "HUMAN_REVIEW",
        title: "Outbound request needs a reviewer",
        step: "Step 11",
        needsAnswer: true,
        detail:
          "Step 11 posts to an address outside your declared integrations. Explain the purpose so a reviewer can approve it.",
      },
      {
        submissionId: submission.id,
        severity: "QUALITY",
        title: "Missing output description",
        detail:
          "Users see this on the product page. One sentence per output is enough.",
      },
    ],
  });

  // ---------------------------------------------------- admin review queue
  const queue: {
    slug: string;
    version: string;
    creatorId: string;
    submittedAt: Date;
    checks: Partial<Record<"parsing" | "secrets" | "compatibility" | "security" | "quality" | "policy", "PASSED" | "PARTIAL" | "FAILED" | "HUMAN_REVIEW" | "FIXED">>;
    flags: { severity: "BLOCKER" | "HUMAN_REVIEW" | "QUALITY"; title: string; detail: string }[];
  }[] = [
    {
      slug: "lead-enrichment",
      version: "1.0",
      creatorId: dana.id,
      submittedAt: d(18, 3, 0),
      checks: {},
      flags: [{ severity: "HUMAN_REVIEW", title: "Code step", detail: "A code step needs a reviewer's eye before publishing." }],
    },
    {
      slug: "research-assistant",
      version: "2.0",
      creatorId: omar.id,
      submittedAt: d(18, 0, 0),
      checks: {},
      flags: [{ severity: "HUMAN_REVIEW", title: "Tool allow-list", detail: "The agent declares a tool allow-list that needs review." }],
    },
    {
      slug: "payroll-helper",
      version: "1.0",
      creatorId: newCreator.id,
      submittedAt: d(17, 9, 0),
      checks: { secrets: "FAILED" },
      flags: [{ severity: "BLOCKER", title: "Database access", detail: "Direct database access from a new creator. Needs a decision." }],
    },
    {
      slug: "seo-auditor",
      version: "1.3",
      creatorId: lina.id,
      submittedAt: d(17, 8, 0),
      checks: { quality: "PARTIAL" },
      flags: [],
    },
    {
      slug: "crm-sync",
      version: "2.1",
      creatorId: karim.id,
      submittedAt: d(16, 8, 0),
      checks: {},
      flags: [],
    },
  ];

  for (const item of queue) {
    const created = await prisma.submission.create({
      data: {
        productId: products[item.slug].id,
        creatorId: item.creatorId,
        version: item.version,
        state: "UNDER_REVIEW",
        submittedAt: item.submittedAt,
        checkDurationMs: 35_000,
        ...item.checks,
      },
    });
    if (item.flags.length > 0) {
      await prisma.submissionIssue.createMany({
        data: item.flags.map((f) => ({
          submissionId: created.id,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
        })),
      });
    }
  }

  console.log("Seeded.");
  console.log(`  ${specs.length} products, ${installSpecs.length} installations, ${runSpecs.length} runs`);
  console.log(`  sign in as nora@acme.co (user + admin) or rami@studio.co (creator), password: ${DEMO_PASSWORD}`);
}

function credentialLabel(credentialType: string) {
  const labels: Record<string, string> = {
    googleSheetsOAuth2Api: "Google Sheets",
    googleDriveOAuth2Api: "Google Drive",
    facebookGraphApi: "Instagram",
    slackApi: "Slack",
    microsoftTeamsOAuth2Api: "Microsoft Teams",
    hubspotApi: "HubSpot",
    openAiApi: "AI model",
  };
  return labels[credentialType] ?? credentialType;
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
