import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { splitList } from "@/lib/n8n";
import type { Prisma, ProductStatus } from "@/generated/prisma";

/**
 * Inbound from MP · Publish Sync.
 *
 * This is the answer to the third open decision in the handover: the platform
 * keeps a local mirror and n8n pushes changes to it, rather than the marketplace
 * reading the Data Table API on every request. Search, filtering, sorting and
 * category counts are not things that API can do per page load.
 *
 * The sweep's own lesson is honoured here too: a template the sync does not
 * mention is left alone. A transient n8n outage must never read as a mass
 * delete, which is exactly the bug the handover says was found in testing.
 */

const Row = z.object({
  templateId: z.string(),
  status: z.enum([
    "in_review",
    "published",
    "blocked_durability",
    "withdrawn",
    "deleted",
    "security_hold",
  ]),
  n8nWorkflowId: z.string().optional(),
  requiredCredentials: z.string().optional(),
  externalHosts: z.string().optional(),
  flaggedNodes: z.string().optional(),
  credentialDurability: z.string().optional(),
  rejectionReason: z.string().optional(),
  creatorId: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  actionType: z.enum(["read", "write"]).optional(),
  invocationMode: z.string().optional(),
  inputSchema: z.string().optional(),
  version: z.number().optional(),
});

const Body = z.object({ rows: z.array(Row) });

// ASCII only, like the creator upload's slugify. A Unicode slug (an Arabic title)
// is stored and listed fine, but the product page's dynamic route 404s on it.
function slugify(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function parseInputSchema(raw: string | undefined): Prisma.InputJsonValue {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Prisma.InputJsonValue;
  } catch {
    return [];
  }
}

const STATUS: Record<z.infer<typeof Row>["status"], ProductStatus> = {
  in_review: "IN_REVIEW",
  published: "PUBLISHED",
  blocked_durability: "BLOCKED_DURABILITY",
  withdrawn: "WITHDRAWN",
  deleted: "DELETED",
  security_hold: "SECURITY_HOLD",
};

export async function POST(request: Request) {
  // A shared token, checked in constant work. Without it, anyone who finds this
  // URL can rewrite the catalogue.
  const token = request.headers.get("x-sync-token");
  if (!env.n8n.syncToken || token !== env.n8n.syncToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Bad payload", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let updated = 0;
  let created = 0;
  let unknown = 0;

  for (const row of parsed.data.rows) {
    const product = await prisma.product.findUnique({
      where: { templateId: row.templateId },
    });

    // A template the platform has never seen is reported, not invented. The one
    // exception is a published workflow an administrator built for the platform:
    // it carries its own title and description, so it can go live directly.
    if (!product) {
      const creator = row.creatorId
        ? await prisma.user.findUnique({ where: { id: row.creatorId }, select: { id: true, roles: true } })
        : null;
      if (!creator?.roles.includes("ADMIN") || row.status !== "published" || !row.title || !row.description) {
        unknown += 1;
        continue;
      }
      await prisma.product.create({
        data: {
          slug: `${slugify(row.title) || "product"}-${row.templateId}`,
          templateId: row.templateId,
          n8nWorkflowId: row.n8nWorkflowId ?? null,
          creatorId: creator.id,
          title: row.title,
          summary: row.description.split("\n")[0].slice(0, 200),
          description: row.description,
          needsFromYou: "",
          kind: "WORKFLOW",
          category: row.category ?? "general",
          actionType: row.actionType === "write" ? "WRITE" : "READ",
          status: STATUS[row.status],
          version: String(row.version ?? 1),
          invocationMode: row.invocationMode ?? "on_demand",
          inputSchema: parseInputSchema(row.inputSchema),
          requiredCredentials: splitList(row.requiredCredentials ?? ""),
          externalHosts: splitList(row.externalHosts ?? ""),
          flaggedNodes: splitList(row.flaggedNodes ?? ""),
          credentialDurability: row.credentialDurability ?? "durable",
          rejectionReason: row.rejectionReason ?? null,
          publishedAt: row.status === "published" ? new Date() : null,
        },
      });
      created += 1;
      continue;
    }

    // RESTRICTED and SUSPENDED are platform decisions with no equivalent in the
    // workflow's enum, so a sync must not quietly undo one.
    if (product.status === "RESTRICTED" || product.status === "SUSPENDED") {
      continue;
    }

    const next = STATUS[row.status];
    await prisma.product.update({
      where: { id: product.id },
      data: {
        status: next,
        n8nWorkflowId: row.n8nWorkflowId ?? product.n8nWorkflowId,
        requiredCredentials: row.requiredCredentials
          ? splitList(row.requiredCredentials)
          : product.requiredCredentials,
        externalHosts: row.externalHosts
          ? splitList(row.externalHosts)
          : product.externalHosts,
        flaggedNodes: row.flaggedNodes
          ? splitList(row.flaggedNodes)
          : product.flaggedNodes,
        credentialDurability:
          row.credentialDurability ?? product.credentialDurability,
        rejectionReason: row.rejectionReason ?? product.rejectionReason,
        publishedAt:
          next === "PUBLISHED" ? (product.publishedAt ?? new Date()) : product.publishedAt,
      },
    });
    updated += 1;
  }

  return NextResponse.json({ ok: true, updated, created, unknown });
}
