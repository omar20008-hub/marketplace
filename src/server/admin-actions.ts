"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { hashPassword, requireRole } from "@/lib/auth";
import { initialsFor } from "@/lib/initials";
import { n8n } from "@/lib/n8n";

/**
 * Review decisions.
 *
 * Approval and rejection publish or reject the template inside n8n itself
 * first — the platform cannot decide either on its own behalf — and only then
 * record the decision locally. n8n refuses an approve on its own when the
 * template's connections are not durable (credentialDurability = blocked); the
 * platform does not check that condition before calling it, only the
 * unrelated BLOCKER-issue gate below, which already covers the same case from
 * the original upload reply.
 *
 * Every decision is written to the audit log with the reviewer's name and their
 * reason. No path here can skip that.
 */

export type DecisionState = { error?: string };

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

export async function approve(
  _prev: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const admin = await requireRole("ADMIN");
  const submissionId = String(formData.get("submissionId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return {};

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { product: true, issues: true },
  });
  if (!submission) return {};

  // A blocker is not something a reason can wave through.
  if (submission.issues.some((issue) => issue.severity === "BLOCKER")) return {};

  const published = await n8n.approveTemplate({
    templateId: submission.product.templateId ?? submission.product.id,
  });
  if (!published.ok) {
    return { error: published.error };
  }

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
        invocationMode: submission.invocationMode,
        inputFields: submission.inputFields,
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
  return {};
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

export async function reject(
  _prev: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const admin = await requireRole("ADMIN");
  const submissionId = String(formData.get("submissionId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return {};

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { product: true },
  });
  if (!submission) return {};

  const rejected = await n8n.rejectTemplate({
    templateId: submission.product.templateId ?? submission.product.id,
    reason,
  });
  if (!rejected.ok) {
    return { error: rejected.error };
  }

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
  return {};
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

/** Matches scripts/create-admin.ts's own floor — and lib/env.ts's, for a secret. */
const MIN_PASSWORD_LENGTH = 12;

export type CreateUserState = { error?: string; createdEmail?: string };

/**
 * The web equivalent of scripts/create-admin.ts, for every account after the
 * first. There is still no public sign-up — see that script's own comment on
 * why — so short of a shell on the host, this is the only way a name becomes
 * an account.
 *
 * New accounts start USER-only. Creator and Admin are granted afterward, from
 * the same table this form sits above, rather than chosen here — one job.
 *
 * Unlike every other action in this file, wrong input here is common enough
 * (a mistyped email, a password under the floor, an address already taken)
 * that a silent no-op would just look broken. This one returns what to show,
 * the same shape login() already does for the same reason.
 */
export async function createUser(
  _prev: CreateUserState,
  formData: FormData,
): Promise<CreateUserState> {
  const admin = await requireRole("ADMIN");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const planId = String(formData.get("planId") ?? "");

  if (!email || !email.includes("@")) {
    return { error: "Enter a valid email address." };
  }
  if (!name) {
    return { error: "Enter a name." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (!planId) {
    return { error: "Choose a plan." };
  }

  const [existing, plan] = await Promise.all([
    prisma.user.findUnique({ where: { email } }),
    prisma.plan.findUnique({ where: { id: planId } }),
  ]);
  if (existing) {
    return { error: `${email} already has an account.` };
  }
  if (!plan) {
    return { error: "That plan no longer exists." };
  }

  const user = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash: await hashPassword(password),
      initials: initialsFor(name),
      planId: plan.id,
      roles: ["USER"],
    },
  });

  await record(admin.id, "create user", user.email, "");
  revalidatePath("/admin");

  return { createdEmail: user.email };
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
