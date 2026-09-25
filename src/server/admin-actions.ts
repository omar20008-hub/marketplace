"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";

/**
 * Review decisions.
 *
 * One open decision from the handover lives here. Approval in the architecture
 * means publishing the workflow inside n8n itself, and no API path exists for
 * the platform to do that on a reviewer's behalf. So these actions record the
 * decision, move the mirror, and write the audit entry — and the panel points
 * the reviewer at the workflow in n8n to finish the publish. When that API path
 * is agreed, the call goes in approve(), and nothing else changes.
 *
 * Every decision is written to the audit log with the reviewer's name and their
 * reason. No path here can skip that.
 */

async function record(
  actorId: string,
  action: string,
  subject: string,
  reason: string,
) {
  await prisma.auditLog.create({
    data: { actorId, action, subject, reason },
  });
}

export async function approve(formData: FormData) {
  const admin = await requireRole("ADMIN");
  const submissionId = String(formData.get("submissionId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return;

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { product: true, issues: true },
  });
  if (!submission) return;

  // A blocker is not something a reason can wave through.
  if (submission.issues.some((issue) => issue.severity === "BLOCKER")) return;

  await prisma.$transaction([
    prisma.submission.update({
      where: { id: submission.id },
      data: {
        state: "APPROVED",
        decidedById: admin.id,
        decidedAt: new Date(),
        decisionReason: reason,
      },
    }),
    prisma.product.update({
      where: { id: submission.productId },
      data: {
        status: "PUBLISHED",
        version: submission.version,
        platformApproved: true,
        securityCheckedAt: new Date(),
        publishedAt: new Date(),
        rejectionReason: null,
      },
    }),
    prisma.productVersion.updateMany({
      where: { productId: submission.productId },
      data: { current: false },
    }),
  ]);

  await prisma.productVersion.upsert({
    where: {
      productId_version: {
        productId: submission.productId,
        version: submission.version,
      },
    },
    create: {
      productId: submission.productId,
      version: submission.version,
      current: true,
      publishedAt: new Date(),
    },
    update: { current: true, publishedAt: new Date() },
  });

  await record(
    admin.id,
    "approve",
    `${submission.product.title} v${submission.version}`,
    reason,
  );

  revalidatePath("/admin");
  revalidatePath("/marketplace");
}

export async function requestChanges(formData: FormData) {
  const admin = await requireRole("ADMIN");
  const submissionId = String(formData.get("submissionId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return;

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { product: true },
  });
  if (!submission) return;

  await prisma.submission.update({
    where: { id: submission.id },
    data: {
      state: "CHANGES_REQUESTED",
      decidedById: admin.id,
      decidedAt: new Date(),
      decisionReason: reason,
    },
  });

  await record(
    admin.id,
    "request changes",
    `${submission.product.title} v${submission.version}`,
    reason,
  );

  revalidatePath("/admin");
}

export async function reject(formData: FormData) {
  const admin = await requireRole("ADMIN");
  const submissionId = String(formData.get("submissionId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return;

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { product: true },
  });
  if (!submission) return;

  await prisma.$transaction([
    prisma.submission.update({
      where: { id: submission.id },
      data: {
        state: "REJECTED",
        decidedById: admin.id,
        decidedAt: new Date(),
        decisionReason: reason,
      },
    }),
    prisma.product.update({
      where: { id: submission.productId },
      data: {
        // A rejection never touches a version that is already live.
        status:
          submission.product.status === "PUBLISHED" ? "PUBLISHED" : "WITHDRAWN",
        rejectionReason: reason,
      },
    }),
  ]);

  await record(
    admin.id,
    "reject",
    `${submission.product.title} v${submission.version}`,
    reason,
  );

  revalidatePath("/admin");
}

/** Security hold. Lifecycle Sweep disables every installation of it overnight. */
export async function hold(formData: FormData) {
  const admin = await requireRole("ADMIN");
  const productId = String(formData.get("productId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return;

  const product = await prisma.product.update({
    where: { id: productId },
    data: { status: "SECURITY_HOLD", restrictionNote: reason },
  });

  await record(admin.id, "security hold", product.title, reason);
  revalidatePath("/admin");
  revalidatePath("/marketplace");
}

/**
 * Grants or revokes CREATOR or ADMIN for another account, from the Users tab.
 * USER is not toggleable here — it is the floor every account starts on
 * (`@default([USER])`), and nothing in the codebase gives meaning to an
 * account with no roles at all.
 *
 * Revoking ADMIN has two refusals, both silent no-ops like every other
 * refusal in this file rather than errors: an admin can never drop their own
 * access from this panel — that is how a lockout happens by accident, not on
 * purpose — and the platform can never be left with zero admins, checked by
 * count rather than assumed, in case that ever stops being equivalent to "not
 * yourself".
 */
export async function toggleRole(formData: FormData) {
  const admin = await requireRole("ADMIN");
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");
  if (role !== "CREATOR" && role !== "ADMIN") return;

  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) return;

  const has = target.roles.includes(role);

  if (role === "ADMIN" && has) {
    if (target.id === admin.id) return;
    const adminCount = await prisma.user.count({ where: { roles: { has: "ADMIN" } } });
    if (adminCount <= 1) return;
  }

  await prisma.user.update({
    where: { id: target.id },
    data: {
      roles: has ? target.roles.filter((r) => r !== role) : [...target.roles, role],
    },
  });

  await record(
    admin.id,
    has ? `revoke ${role.toLowerCase()}` : `grant ${role.toLowerCase()}`,
    target.email,
    "",
  );

  revalidatePath("/admin");
}
