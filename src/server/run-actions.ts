"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  executeRun,
  fields,
  matchInstallation,
  titleFor,
} from "./run-engine";

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
