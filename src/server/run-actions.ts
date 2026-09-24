"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser, type Viewer } from "@/lib/auth";
import { n8n } from "@/lib/n8n";
import { readinessFor } from "@/lib/readiness";
import type { Prisma } from "@/generated/prisma";

type InputField = {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  note?: string;
};

function fields(product: { inputSchema: Prisma.JsonValue }): InputField[] {
  return Array.isArray(product.inputSchema)
    ? (product.inputSchema as unknown as InputField[])
    : [];
}

/**
 * The steps shown in the thread. The dispatcher returns one result with no
 * progress of its own, so the platform declares the shape of a run up front and
 * marks the whole set done when the reply arrives. Honest about being an
 * outline, not a trace — which is why every step carries the same timestamp.
 */
function stepLabels(product: {
  title: string;
  actionType: "READ" | "WRITE";
  outputs: Prisma.JsonValue;
}) {
  const outputs = Array.isArray(product.outputs)
    ? (product.outputs as unknown as { name: string }[])
    : [];
  const labels = ["Check connections", `Run ${product.title}`];
  if (outputs[0]) labels.push(`Produce ${outputs[0].name.toLowerCase()}`);
  if (product.actionType === "WRITE") labels.push("Deliver the result");
  return labels;
}

function handle() {
  return randomBytes(2).toString("hex");
}

function titleFor(task: string) {
  const trimmed = task.trim().replace(/\s+/g, " ");
  const short = trimmed.length > 48 ? `${trimmed.slice(0, 45)}…` : trimmed;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** Deterministic, explainable matching — no model involved on this path. */
function matchInstallation(
  task: string,
  installations: {
    id: string;
    product: { title: string; summary: string; category: string };
  }[],
) {
  const words = new Set(
    task
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3),
  );
  let best: { id: string; score: number } | null = null;

  for (const installation of installations) {
    const haystack =
      `${installation.product.title} ${installation.product.summary} ${installation.product.category}`.toLowerCase();
    let score = 0;
    for (const word of words) if (haystack.includes(word)) score += 1;
    if (score > 0 && (!best || score > best.score)) {
      best = { id: installation.id, score };
    }
  }
  return best?.id ?? null;
}

async function runsThisMonth(userId: string) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return prisma.run.count({
    where: { userId, startedAt: { gte: start }, charged: true },
  });
}

/**
 * Starts a run and records the outcome. Every refusal happens here, before the
 * dispatcher is called, so a blocked run never costs the user anything.
 */
export async function executeRun({
  user,
  installationId,
  args,
  threadId,
}: {
  user: Viewer;
  installationId: string;
  args: Record<string, unknown>;
  threadId?: string;
}) {
  const installation = await prisma.installation.findFirst({
    where: { id: installationId, userId: user.id },
    include: { product: { include: { requirements: true } } },
  });
  if (!installation) return null;

  const accounts = await prisma.connectedAccount.findMany({
    where: { userId: user.id },
  });

  const base = {
    runId: handle(),
    userId: user.id,
    installationId: installation.id,
    productId: installation.productId,
    productVersion: installation.pinnedVersion,
    threadId,
  };

  const readiness = readinessFor({
    productStatus: installation.product.status,
    requirements: installation.product.requirements,
    accounts,
    installed: true,
    installationStatus: installation.status,
  });

  if (readiness.tone === "partial" || readiness.tone === "blocked") {
    return prisma.run.create({
      data: {
        ...base,
        result: "BLOCKED",
        errorType: "connection",
        message: `${readiness.missing.join(", ")} needs your attention before this can run.`,
        finishedAt: new Date(),
        durationMs: 0,
        charged: false,
        chargeNote: "not charged",
        steps: { create: [{ idx: 0, label: "Check connections", status: "FAILED" }] },
      },
      include: { steps: true },
    });
  }

  const used = await runsThisMonth(user.id);
  if (used >= user.plan.monthlyRuns) {
    return prisma.run.create({
      data: {
        ...base,
        result: "BLOCKED",
        errorType: "plan limit",
        message: `You have used ${used.toLocaleString()} of ${user.plan.monthlyRuns.toLocaleString()} runs on ${user.plan.name}. This run was stopped before anything was spent.`,
        finishedAt: new Date(),
        durationMs: 0,
        charged: false,
        chargeNote: "not charged",
        steps: { create: [{ idx: 0, label: "Check plan", status: "FAILED" }] },
      },
      include: { steps: true },
    });
  }

  const startedAt = Date.now();
  const schema = fields(installation.product);

  // userId comes from the session. Never from the form, never from a model.
  const reply = await n8n.dispatch({
    userId: user.id,
    installationId: installation.installationId ?? installation.id,
    args: { ...args, __schema: schema },
  });

  const durationMs = Date.now() - startedAt;
  const labels = stepLabels(installation.product);

  if (reply.result === "incomplete") {
    const missing = reply.missing.split(",").filter(Boolean);
    return prisma.run.create({
      data: {
        ...base,
        result: "INCOMPLETE",
        errorType: "missing input",
        message: reply.message,
        finishedAt: new Date(),
        durationMs,
        charged: false,
        chargeNote: "not charged",
        steps: {
          create: [
            { idx: 0, label: "Check connections", status: "DONE" },
            { idx: 1, label: `Need ${missing.join(", ")}`, status: "FAILED" },
          ],
        },
      },
      include: { steps: true },
    });
  }

  if (reply.result === "denied" || reply.result === "error") {
    const failed = await prisma.run.create({
      data: {
        ...base,
        result: reply.result === "denied" ? "DENIED" : "ERROR",
        errorType: reply.result === "denied" ? reply.reason : reply.errorType,
        finishedAt: new Date(),
        durationMs,
        // A failure caused by us is never counted against the plan.
        charged: false,
        chargeNote: "not charged",
        steps: {
          create: labels.map((label, idx) => ({
            idx,
            label,
            status: idx === 0 ? ("DONE" as const) : ("FAILED" as const),
          })),
        },
      },
      include: { steps: true },
    });

    // Five consecutive failures disable the instance. The dispatcher does this
    // on its side; the mirror has to agree or the workspace lies.
    const failures = installation.failureCount + 1;
    await prisma.installation.update({
      where: { id: installation.id },
      data: {
        failureCount: failures,
        status: failures >= 5 ? "DISABLED" : installation.status,
        attentionNote:
          failures >= 5
            ? "Disabled automatically after five failures in a row."
            : installation.attentionNote,
      },
    });

    return failed;
  }

  const outputs = Array.isArray(installation.product.outputs)
    ? (installation.product.outputs as unknown as { name: string; note: string }[])
    : [];

  const run = await prisma.run.create({
    data: {
      ...base,
      result: "SUCCESS",
      finishedAt: new Date(),
      durationMs,
      message: reply.toolOutput.slice(0, 500),
      steps: {
        create: labels.map((label, idx) => ({ idx, label, status: "DONE" as const })),
      },
    },
    include: { steps: true },
  });

  if (outputs[0]) {
    const name = `${installation.product.slug}-${run.runId}.txt`;
    const content = Buffer.from(reply.toolOutput, "utf8").toString("base64");
    const stored = await n8n.storage({
      installationId: installation.installationId ?? installation.id,
      operation: "put",
      path: `results/${name}`,
      content,
      mimeType: "text/plain",
    });

    await prisma.artifact.create({
      data: {
        runId: run.id,
        name,
        path: `results/${name}`,
        mimeType: "text/plain",
        sizeBytes: "size" in stored && typeof stored.size === "number" ? stored.size : 0,
        backend: installation.storageBackend,
        objectRef:
          "objectRef" in stored && typeof stored.objectRef === "string"
            ? stored.objectRef
            : `platform://${installation.id}/results/${name}`,
      },
    });
  }

  await prisma.installation.update({
    where: { id: installation.id },
    data: { lastRunAt: new Date(), failureCount: 0 },
  });

  return run;
}

export async function startTask(formData: FormData) {
  const user = await requireUser();
  const task = String(formData.get("task") ?? "").trim();
  if (!task) return;

  const pinned = String(formData.get("installationId") ?? "");

  const installations = await prisma.installation.findMany({
    where: { userId: user.id, status: { in: ["ACTIVE", "PARTIAL"] } },
    include: { product: true },
  });

  const chosen =
    installations.find((i) => i.id === pinned)?.id ??
    matchInstallation(task, installations);

  const thread = await prisma.thread.create({
    data: {
      userId: user.id,
      title: titleFor(task),
      messages: { create: [{ role: "USER", body: task }] },
    },
  });

  if (!chosen) {
    await prisma.message.create({
      data: {
        threadId: thread.id,
        role: "ASSISTANT",
        body:
          "Nothing in your workspace matches that yet. Have a look in the " +
          "Marketplace — I only run products you already own.",
      },
    });
    redirect(`/tasks/${thread.id}`);
  }

  const installation = installations.find((i) => i.id === chosen)!;

  // Fill the first required text field from the task itself, the way the
  // orchestrator would from the conversation. Anything else it cannot know
  // comes back from the deterministic validator as "incomplete".
  const schema = fields(installation.product);
  const args: Record<string, unknown> = {};
  const firstText = schema.find(
    (field) => field.required !== false && ["string", "text"].includes(field.type),
  );
  if (firstText) args[firstText.name] = task;

  const run = await executeRun({
    user,
    installationId: installation.id,
    args,
    threadId: thread.id,
  });

  await prisma.message.create({
    data: {
      threadId: thread.id,
      role: "ASSISTANT",
      runId: run?.id,
      body:
        run?.result === "SUCCESS"
          ? "I found a match in your workspace. It's connected and ready, so I started the run."
          : run?.result === "INCOMPLETE"
            ? "I matched a product, but it needs a couple of details before it can run."
            : "I matched a product, but it can't run right now.",
    },
  });

  revalidatePath("/", "layout");
  redirect(`/tasks/${thread.id}`);
}

/** Re-runs after the user has supplied what the validator asked for. */
export async function provideInputs(formData: FormData) {
  const user = await requireUser();
  const runId = String(formData.get("runId") ?? "");

  const previous = await prisma.run.findFirst({
    where: { id: runId, userId: user.id },
    include: { product: true },
  });
  if (!previous) return;

  const args: Record<string, unknown> = {};
  for (const field of fields(previous.product)) {
    const value = formData.get(field.name);
    if (value !== null && String(value).length > 0) {
      args[field.name] =
        field.type === "number" ? Number(value) : String(value);
    }
  }

  const run = await executeRun({
    user,
    installationId: previous.installationId,
    args,
    threadId: previous.threadId ?? undefined,
  });

  if (previous.threadId) {
    await prisma.message.create({
      data: {
        threadId: previous.threadId,
        role: "ASSISTANT",
        runId: run?.id,
        body:
          run?.result === "SUCCESS"
            ? "Thanks — that was everything it needed. The run is done."
            : "Still missing something. Have a look below.",
      },
    });
    revalidatePath(`/tasks/${previous.threadId}`);
  }
}

/** The Run button in My workspace. Opens a thread so the result has a home. */
export async function runFromWorkspace(formData: FormData) {
  const user = await requireUser();
  const installationId = String(formData.get("installationId") ?? "");

  const installation = await prisma.installation.findFirst({
    where: { id: installationId, userId: user.id },
    include: { product: true },
  });
  if (!installation) return;

  const thread = await prisma.thread.create({
    data: {
      userId: user.id,
      title: installation.product.title,
      messages: {
        create: [{ role: "USER", body: `Run ${installation.product.title}.` }],
      },
    },
  });

  const run = await executeRun({
    user,
    installationId: installation.id,
    args: {},
    threadId: thread.id,
  });

  await prisma.message.create({
    data: {
      threadId: thread.id,
      role: "ASSISTANT",
      runId: run?.id,
      body:
        run?.result === "SUCCESS"
          ? "Done."
          : run?.result === "INCOMPLETE"
            ? "It needs a few details first."
            : "It could not run.",
    },
  });

  revalidatePath("/", "layout");
  redirect(`/tasks/${thread.id}`);
}
