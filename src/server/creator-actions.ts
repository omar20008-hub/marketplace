"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { n8n, splitList } from "@/lib/n8n";

export type UploadState = { error?: string };

function slugify(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/**
 * Uploading a product.
 *
 * The safety scan, the secret stripping, the durability rule and the schema
 * extraction all happen inside MP · Upload & Provision. Nothing here repeats
 * any of it — this reads the reply and records what it said.
 */
export async function uploadProduct(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const creator = await requireRole("CREATOR");

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const summary = String(formData.get("summary") ?? "").trim() || description.slice(0, 120);
  const category = String(formData.get("category") ?? "Operations");
  const kind = String(formData.get("kind") ?? "WORKFLOW") === "AGENT" ? "AGENT" : "WORKFLOW";
  const actionType = String(formData.get("actionType") ?? "read") === "write" ? "write" : "read";
  const file = formData.get("file");

  if (!title || !description) {
    return { error: "A title and a description are required." };
  }
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Attach the exported workflow JSON." };
  }

  const text = await file.text();

  const reply = await n8n.upload({
    creatorId: creator.id,
    title,
    description,
    actionType,
    file: text,
  });

  // A rejection is not a product. Nothing is written except the reason.
  if ("ok" in reply) {
    return { error: reply.errorText };
  }

  const slug = slugify(title);
  const existing = await prisma.product.findUnique({ where: { slug } });

  const product = await prisma.product.upsert({
    where: { slug },
    create: {
      slug,
      templateId: reply.templateId,
      creatorId: creator.id,
      title,
      summary,
      description,
      needsFromYou:
        splitList(reply.requiredCredentials).length > 0
          ? `Your ${splitList(reply.requiredCredentials).join(", ")} account.`
          : "Nothing. Everything this needs is provided by the platform.",
      kind,
      category,
      actionType: actionType === "write" ? "WRITE" : "READ",
      status: "IN_REVIEW",
      nodeCount: reply.nodeCount,
      requiredCredentials: splitList(reply.requiredCredentials),
      externalHosts: splitList(reply.externalHosts),
      flaggedNodes: splitList(reply.flaggedNodes),
      credentialDurability: reply.credentialDurability,
      invocationMode: reply.invocationMode,
      inputFields: splitList(reply.inputFields),
    },
    update: {
      templateId: reply.templateId,
      summary,
      description,
      status: "IN_REVIEW",
      nodeCount: reply.nodeCount,
      requiredCredentials: splitList(reply.requiredCredentials),
      externalHosts: splitList(reply.externalHosts),
      flaggedNodes: splitList(reply.flaggedNodes),
      credentialDurability: reply.credentialDurability,
      invocationMode: reply.invocationMode,
      inputFields: splitList(reply.inputFields),
    },
  });

  // The six-category report the studio shows is the platform's presentation of
  // this one reply — it is not a second scan.
  const blocked = reply.credentialDurability === "blocked";
  const flagged = splitList(reply.flaggedNodes);

  const submission = await prisma.submission.create({
    data: {
      productId: product.id,
      creatorId: creator.id,
      version: existing ? bumpMinor(existing.version) : product.version,
      state: blocked ? "VALIDATION_FAILED" : "UNDER_REVIEW",
      checkDurationMs: 0,
      parsing: "PASSED",
      secrets: "FIXED",
      compatibility: blocked ? "FAILED" : "PASSED",
      security: flagged.length > 0 ? "HUMAN_REVIEW" : "PASSED",
      quality: summary === description.slice(0, 120) ? "PARTIAL" : "PASSED",
      policy: "PASSED",
      secretsRemoved: 0,
      invocationMode: reply.invocationMode,
      inputFields: splitList(reply.inputFields),
      inferenceStatus: reply.inferenceStatus,
      notes: reply.notes || null,
    },
  });

  if (blocked) {
    await prisma.submissionIssue.create({
      data: {
        submissionId: submission.id,
        severity: "BLOCKER",
        title: "A required connection has no sign-in flow",
        detail:
          `This product needs ${splitList(reply.requiredCredentials).join(", ")}, ` +
          "which users cannot authorise on the platform yet. It cannot be published " +
          "until that flow exists.",
      },
    });
  }

  for (const node of flagged) {
    await prisma.submissionIssue.create({
      data: {
        submissionId: submission.id,
        severity: "HUMAN_REVIEW",
        title: `${node} needs a reviewer`,
        detail:
          "This component can do more than the product page describes, so a " +
          "person looks at it before it is published.",
        needsAnswer: true,
      },
    });
  }

  revalidatePath("/creator");
  redirect(`/creator?submission=${submission.id}`);
}

/** The creator's answer to a reviewer's question about a flagged step. */
export async function answerIssue(formData: FormData) {
  const creator = await requireRole("CREATOR");
  const issueId = String(formData.get("issueId") ?? "");
  const answer = String(formData.get("answer") ?? "").trim();
  if (!answer) return;

  const issue = await prisma.submissionIssue.findFirst({
    where: { id: issueId, submission: { creatorId: creator.id } },
  });
  if (!issue) return;

  await prisma.submissionIssue.update({
    where: { id: issue.id },
    data: { answer },
  });

  revalidatePath("/creator");
}

export async function resubmit(formData: FormData) {
  const creator = await requireRole("CREATOR");
  const submissionId = String(formData.get("submissionId") ?? "");

  const submission = await prisma.submission.findFirst({
    where: { id: submissionId, creatorId: creator.id },
    include: { issues: true },
  });
  if (!submission) return;

  const unanswered = submission.issues.filter(
    (issue) => issue.severity === "BLOCKER" || (issue.needsAnswer && !issue.answer),
  );
  if (unanswered.length > 0) return;

  await prisma.submission.update({
    where: { id: submission.id },
    data: { state: "UNDER_REVIEW", submittedAt: new Date() },
  });

  revalidatePath("/creator");
}

function bumpMinor(version: string) {
  const [major, minor = "0"] = version.split(".");
  return `${major}.${Number(minor) + 1}`;
}
